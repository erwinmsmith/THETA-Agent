import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { ThetaTurnOrchestrator } from '../conversation/turn-orchestrator.js';
import { isAutonomousDelegationAnswer } from '../agent/decision-gap.js';
import { DatasetCorrectionService } from '../dataset-understanding/correction-service.js';
import type {
  DatasetFacts,
  DatasetUnderstandingDraft,
} from '../dataset-understanding/contracts.js';
import { DoctorService } from '../doctor-service.js';
import { loadThetaProjectEnvironment } from '../environment.js';
import { buildHumanResponse } from '../presentation/human-response-builder.js';
import { ResultAnalysisService } from '../results/result-analysis-service.js';
import { ResultService } from '../results/result-service.js';
import { deleteLocalRun, listLocalRuns } from '../storage/run-catalog.js';
import { SQLiteConversationStore } from '../storage/sqlite-conversation-store.js';
import { SQLiteDatasetRegistry, type DatasetRecord } from '../storage/dataset-registry.js';
import { THETA_APPROVAL_KEYS } from '../theta-domain.js';
import {
  ThetaWorkflowService,
  type ThetaWorkflowConversationContext,
} from '../theta-workflow-service.js';
import { resolveDatasetFile } from '../tools/dataset-path-policy.js';
import { runThetaModelCatalog } from '../tools/hypha-runner.js';
import { runThetaTrainingStatus } from '../tools/hypha-runner.js';
import {
  thetaResultAnalysisRequestSchema,
  thetaWebCreateRunSchema,
  thetaWebRunActionSchema,
  type ThetaWebApiEnvelope,
  type ThetaWebApiHealth,
  type ThetaWebConversationMessage,
  type ThetaWebRunAction,
  type ThetaWebTimelineEntry,
} from './contracts.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultAgentRoot = path.resolve(moduleDirectory, '..', '..');
const resultRootCache = new Map<string, string>();
const localOwner = { userId: 'local_user', workspaceId: 'local_workspace' } as const;
const autonomousDatasetDirection = '数据集主题和方向由THETA自行进行读取和分析。';
const supportedUploadSuffixes = new Set([
  '.csv', '.tsv', '.json', '.jsonl', '.txt', '.xlsx', '.xls', '.parquet',
]);

loadThetaProjectEnvironment();

export interface ThetaWebApiOptions {
  agentRoot?: string;
  runtimeDb?: string;
  host?: string;
  port?: number;
}

export const resolveThetaWebApiOptions = (): Required<ThetaWebApiOptions> => {
  const agentRoot = path.resolve(process.env.THETA_AGENT_ROOT ?? defaultAgentRoot);
  return {
    agentRoot,
    runtimeDb: path.resolve(
      process.env.THETA_WORKFLOW_DB ??
        path.join(agentRoot, '.theta_agent', 'theta-workflow.sqlite'),
    ),
    host: process.env.THETA_WEB_API_HOST ?? '127.0.0.1',
    port: parsePort(process.env.THETA_WEB_API_PORT),
  };
};

export const createThetaWebApiServer = (options: ThetaWebApiOptions = {}) => {
  const defaults = resolveThetaWebApiOptions();
  const resolved = { ...defaults, ...options };
  const workflow = new ThetaWorkflowService();

  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, resolved, workflow);
    } catch (error) {
      const clientError = error instanceof ZodError || error instanceof SyntaxError;
      writeJson(response, clientError ? 400 : 500, {
        ok: false,
        error: {
          code: clientError
            ? 'THETA_WEB_API_INVALID_REQUEST'
            : 'THETA_WEB_API_INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
};

const routeRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<ThetaWebApiOptions>,
  workflow: ThetaWorkflowService,
): Promise<void> => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${options.host}:${options.port}`);

  if (method === 'OPTIONS') {
    writeCors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === '/api/v2/health') {
    if (method !== 'GET') return methodNotAllowed(response);
    const report = await new DoctorService({ agentRoot: options.agentRoot }).run();
    const health: ThetaWebApiHealth = {
      service: 'theta-agent-api',
      version: 'v2',
      ...report,
    };
    writeJson(response, 200, { ok: true, data: health });
    return;
  }

  if (url.pathname === '/api/v2/runs') {
    if (method === 'POST') {
      const input = thetaWebCreateRunSchema.parse(await readJsonBody(request));
      const registry = new SQLiteDatasetRegistry(options.runtimeDb);
      let datasetRecord: DatasetRecord;
      try {
        datasetRecord = input.datasetRef
          ? registry.require(input.datasetRef, localOwner)
          : await registry.registerLocalFile(input.filePath!, localOwner);
      } finally {
        registry.close();
      }
      const dataset = await resolveDatasetFile(datasetRecord.managedPath);
      const researchGoal = input.researchGoal?.trim() || autonomousDatasetDirection;
      const result = await workflow.run({
        input: {
          filePath: dataset.filePath,
          datasetRef: datasetRecord.datasetRef,
          workflowVersion: '2.0.0',
          researchGoal,
          plannerMode: input.useMiniMax ? 'minimax' : 'deterministic',
          allowRemoteSamples: input.allowRemoteSamples,
        },
        runtimeDb: options.runtimeDb,
      });
      const initialContext = await workflow.conversationContext(result.runId, options.runtimeDb);
      persistInitialDatasetConversation(
        options.runtimeDb,
        result.runId,
        initialContext.datasetFacts,
        initialContext.datasetUnderstanding,
        researchGoal,
      );
      writeJson(response, 201, {
        ok: true,
        data: presentRun(result),
      });
      return;
    }
    if (method !== 'GET') return methodNotAllowed(response);
    const limit = boundedLimit(url.searchParams.get('limit'));
    const catalog = listLocalRuns(options.runtimeDb, limit);
    const runs = await Promise.all(
      catalog.map(async (run) => {
        try {
          const [status, plan] = await Promise.all([
            workflow.status(run.runId, options.runtimeDb),
            workflow.plan(run.runId, options.runtimeDb),
          ]);
          return {
            ...run,
            status: status.status,
            currentState: status.currentState,
            pendingReason: status.pendingReason,
            lastEventType: status.lastEventType,
            lastEventAt: status.lastEventAt,
            presentation: buildHumanResponse(status),
            identity: buildRunIdentity(plan),
          };
        } catch {
          return {
            ...run,
            status: 'unknown',
          };
        }
      }),
    );
    const visibleRuns = url.searchParams.get('includeSystem') === '1'
      ? runs
      : runs.filter(isUserFacingRun);
    writeJson(response, 200, {
      ok: true,
      data: { runs: visibleRuns },
    });
    return;
  }

  const compatibilityRunDeleteMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/delete$/);
  const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
  if (compatibilityRunDeleteMatch || runMatch) {
    if (compatibilityRunDeleteMatch ? method !== 'POST' : method !== 'DELETE') {
      return methodNotAllowed(response);
    }
    const runId = decodeURIComponent((compatibilityRunDeleteMatch ?? runMatch)![1]);
    let resultRoot = resultRootCache.get(runId);
    if (!resultRoot) {
      try {
        resultRoot = (await new ResultService(workflow).overview(runId, options.runtimeDb)).resultRoot;
      } catch {
        resultRoot = undefined;
      }
    }

    const deletion = deleteLocalRun(runId, options.runtimeDb);
    if (!deletion.existed) {
      writeJson(response, 404, {
        ok: false,
        error: { code: 'THETA_WEB_API_RUN_NOT_FOUND', message: '未找到要删除的研究项目。' },
      });
      return;
    }

    resultRootCache.delete(runId);
    const resultArtifactsDeleted = await removeRunResultArtifacts(resultRoot, options.agentRoot);
    writeJson(response, 200, {
      ok: true,
      data: { runId, deletedRecords: deletion.deletedRecords, resultArtifactsDeleted },
    });
    return;
  }

  if (url.pathname === '/api/v2/datasets' && method === 'GET') {
    writeJson(response, 200, {
      ok: true,
      data: { datasets: await listDatasets(options.agentRoot, options.runtimeDb) },
    });
    return;
  }

  if (url.pathname === '/api/v2/datasets/upload') {
    if (method !== 'POST') return methodNotAllowed(response);
    const uploaded = await storeUploadedDataset(request, options.agentRoot, options.runtimeDb);
    writeJson(response, 201, { ok: true, data: presentDataset(uploaded) });
    return;
  }

  if (url.pathname === '/api/v2/models' && method === 'GET') {
    const result = await runThetaModelCatalog({ includeExperimental: false });
    if (result.status !== 'completed' || !result.output) {
      throw new Error('无法读取本地 THETA 模型目录。');
    }
    writeJson(response, 200, { ok: true, data: result.output });
    return;
  }

  const statusMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/status$/);
  if (statusMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(statusMatch[1]);
    const context = await workflow.conversationContext(runId, options.runtimeDb);
    const status = context.status;
    writeJson(response, 200, {
      ok: true,
      data: {
        ...status,
        runtimeDb: undefined,
        presentation: buildHumanResponse(status),
        ...(context.datasetProfile ? { datasetProfile: context.datasetProfile } : {}),
        ...(context.researchBrief ? { researchBrief: context.researchBrief } : {}),
        ...(context.datasetFacts ? { datasetFacts: context.datasetFacts } : {}),
        ...(context.datasetUnderstanding ? { datasetUnderstanding: context.datasetUnderstanding } : {}),
        ...(context.datasetUnderstandingMeta ? { datasetUnderstandingMeta: context.datasetUnderstandingMeta } : {}),
        ...(context.remoteSampleReceipt ? { remoteSampleReceipt: context.remoteSampleReceipt } : {}),
        ...(context.datasetConfirmation ? { datasetConfirmation: context.datasetConfirmation } : {}),
        ...(context.researchIntent ? { researchIntent: context.researchIntent } : {}),
        ...(context.researchIntentSummary
          ? { researchIntentSummary: context.researchIntentSummary }
          : {}),
        ...(context.interviewMemory ? { interviewMemory: context.interviewMemory } : {}),
        ...(context.decisionGap ? { decisionGap: context.decisionGap } : {}),
      },
    });
    return;
  }

  const timelineMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/timeline$/);
  if (timelineMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(timelineMatch[1]);
    const limit = boundedLimit(url.searchParams.get('limit'));
    const [status, evidence] = await Promise.all([
      workflow.status(runId, options.runtimeDb),
      workflow.evidence(runId, options.runtimeDb),
    ]);
    const timeline = [...evidence.orchestrationEvents, ...evidence.toolEvents]
      .map(toTimelineEntry)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-limit);
    const trainingRunId = stringField(status.trainingReceipt, 'trainingRunId');
    let training: Record<string, unknown> | undefined;
    let logs: string[] = [];
    if (trainingRunId) {
      const observed = await runThetaTrainingStatus({ trainingRunId, logLimit: 30 });
      if (observed.status === 'completed' && observed.output?.found) {
        training = observed.output.receipt as unknown as Record<string, unknown>;
        logs = observed.output.logs.filter((line) => line.trim()).slice(-12);
      }
    }
    writeJson(response, 200, {
      ok: true,
      data: { runId, timeline, training, logs },
    });
    return;
  }

  const conversationMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/conversation$/);
  if (conversationMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(conversationMatch[1]);
    const limit = boundedLimit(url.searchParams.get('limit'));
    const store = new SQLiteConversationStore(options.runtimeDb);
    try {
      const messages: ThetaWebConversationMessage[] = store
        .listRecentMessages(`theta-web-${runId}`, limit)
        .filter(
          (message) =>
            message.runId === runId &&
            (message.role === 'user' || message.role === 'assistant'),
        )
        .map((message) => ({
          messageId: message.messageId,
          role: message.role as 'user' | 'assistant',
          messageKind: message.messageKind,
          content: message.content,
          sequenceNumber: message.sequenceNumber,
          createdAt: message.createdAt,
        }));
      writeJson(response, 200, { ok: true, data: { runId, messages } });
    } finally {
      store.close();
    }
    return;
  }

  const resultAssetMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/results\/assets\/(.+)$/);
  if (resultAssetMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(resultAssetMatch[1]);
    const relativePath = decodeURIComponent(resultAssetMatch[2]);
    let resultRoot = resultRootCache.get(runId);
    if (!resultRoot) {
      const results = await new ResultService(workflow).overview(runId, options.runtimeDb);
      resultRoot = results.resultRoot;
      if (resultRoot) resultRootCache.set(runId, resultRoot);
    }
    if (!resultRoot) throw new Error('当前任务没有可读取的结果目录。');
    await writeResultAsset(response, resultRoot, relativePath);
    return;
  }

  const resultsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/results$/);
  if (resultsMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(resultsMatch[1]);
    const results = await new ResultService(workflow).overview(runId, options.runtimeDb);
    if (results.resultRoot) resultRootCache.set(runId, results.resultRoot);
    writeJson(response, 200, { ok: true, data: results });
    return;
  }

  const resultAnalysisMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/results\/analysis$/);
  if (resultAnalysisMatch) {
    if (method !== 'POST') return methodNotAllowed(response);
    const runId = decodeURIComponent(resultAnalysisMatch[1]);
    const input = thetaResultAnalysisRequestSchema.parse(await readJsonBody(request));
    const analysis = await new ResultAnalysisService(workflow).analyze(
      runId,
      options.runtimeDb,
      input,
    );
    writeJson(response, 200, { ok: true, data: analysis });
    return;
  }


  const planMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/plan$/);
  if (planMatch && method === 'GET') {
    const runId = decodeURIComponent(planMatch[1]);
    const plan = await workflow.plan(runId, options.runtimeDb);
    writeJson(response, 200, {
      ok: true,
      data: { ...plan, runtimeDb: undefined, presentation: buildHumanResponse(plan) },
    });
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/actions$/);
  if (actionMatch && method === 'POST') {
    const runId = decodeURIComponent(actionMatch[1]);
    const action = thetaWebRunActionSchema.parse(await readJsonBody(request));
    const value = await executeRunAction(
      runId,
      action,
      options.runtimeDb,
      workflow,
    );
    const nextStatus = await workflow.status(
      typeof value === 'object' && value && 'runId' in value
        ? String((value as { runId: unknown }).runId)
        : runId,
      options.runtimeDb,
    );
    writeJson(response, 200, {
      ok: true,
      data: { result: value, status: presentRun(nextStatus) },
    });
    return;
  }

  if (method !== 'GET') return methodNotAllowed(response);

  writeJson(response, 404, {
    ok: false,
    error: {
      code: 'THETA_WEB_API_NOT_FOUND',
      message: 'The requested THETA 2.0 API route does not exist.',
    },
  });
};

const writeJson = (
  response: ServerResponse,
  status: number,
  payload: ThetaWebApiEnvelope,
): void => {
  writeCors(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
};

const writeResultAsset = async (
  response: ServerResponse,
  resultRoot: string,
  relativePath: string,
): Promise<void> => {
  const root = path.resolve(resultRoot);
  const candidate = path.resolve(root, relativePath);
  const boundary = path.relative(root, candidate);
  if (!relativePath || boundary.startsWith('..') || path.isAbsolute(boundary)) {
    throw new Error('结果文件路径超出当前 Run 的结果目录。');
  }
  const extension = path.extname(candidate).toLowerCase();
  const contentTypes: Record<string, string> = {
    '.png': 'image/png',
    '.html': 'text/html; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
  };
  const contentType = contentTypes[extension];
  if (!contentType) throw new Error('该结果文件类型不允许通过网页读取。');
  const metadata = await stat(candidate);
  if (!metadata.isFile()) throw new Error('请求的结果产物不是文件。');
  const content = await readFile(candidate);
  writeCors(response);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(content.byteLength),
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(content);
};

const writeCors = (response: ServerResponse): void => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4320');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Cache-Control', 'no-store');
};

const presentRun = (value: unknown): Record<string, unknown> => {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    ...record,
    runtimeDb: undefined,
    presentation: buildHumanResponse(value),
  };
};

const appendRunMessage = (
  runtimeDb: string,
  runId: string,
  role: 'user' | 'assistant',
  messageKind: string,
  content: string,
): void => {
  const store = new SQLiteConversationStore(runtimeDb);
  try {
    const sessionId = `theta-web-${runId}`;
    store.getOrCreateSession(sessionId, { activeRunId: runId });
    store.appendMessage({
      messageId: `message.${role}.${randomUUID()}`,
      sessionId,
      runId,
      role,
      messageKind,
      content,
      createdAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
};

const recordFailedRunAction = (
  runtimeDb: string,
  runId: string,
  actionName: string,
  error: unknown,
): void => appendRunMessage(
  runtimeDb,
  runId,
  'assistant',
  'operation.failed',
  `${actionName}未完成：${error instanceof Error ? error.message : String(error)}。本次输入已保存，可以修正后重试。`,
);

const executeRunAction = async (
  runId: string,
  action: ThetaWebRunAction,
  runtimeDb: string,
  workflow: ThetaWorkflowService,
): Promise<unknown> => {
  if (action.action === 'retry') {
    return new ResultService(workflow).retry(runId, runtimeDb);
  }
  if (action.action === 'poll') {
    return workflow.resume({ runId, runtimeDb });
  }
  if (action.action === 'confirmDataset') {
    appendRunMessage(
      runtimeDb, runId, 'user', 'dataset.confirmation',
      action.status === 'confirmed'
        ? `确认数据理解，正文列为 ${action.textColumns.join('、')}。`
        : `修正并确认数据理解，正文列为 ${action.textColumns.join('、')}。`,
    );
    let result;
    try {
      result = await workflow.resume({
        runId,
        runtimeDb,
        datasetConfirmation: {
          status: action.status,
          domainLabel: action.domainLabel,
          analysisUnit: action.analysisUnit,
          textColumns: action.textColumns,
          timeColumns: action.timeColumns,
          idColumns: action.idColumns,
          metadataColumns: action.metadataColumns,
          groupColumns: action.groupColumns,
          covariateColumns: action.covariateColumns,
          evaluationColumns: action.evaluationColumns,
          ignoredColumns: action.ignoredColumns,
        },
      });
    } catch (error) {
      recordFailedRunAction(runtimeDb, runId, '数据确认', error);
      throw error;
    }
    const context = await workflow.conversationContext(runId, runtimeDb);
    const store = new SQLiteConversationStore(runtimeDb);
    try {
      const sessionId = `theta-web-${runId}`;
      store.getOrCreateSession(sessionId, { activeRunId: runId });
      if (context.decisionGap) {
        store.appendMessage({
          messageId: `message.assistant.${randomUUID()}`,
          sessionId,
          runId,
          role: 'assistant',
          messageKind: 'research.decision-gap',
          content: context.decisionGap.question,
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      store.close();
    }
    return result;
  }
  if (action.action === 'correctDataset') {
    appendRunMessage(runtimeDb, runId, 'user', 'dataset.correction', action.text);
    const context = await workflow.conversationContext(runId, runtimeDb);
    if (!context.datasetFacts || !context.datasetUnderstanding) {
      const error = new Error('当前 Run 尚未形成可纠正的数据理解。');
      recordFailedRunAction(runtimeDb, runId, '数据修正', error);
      throw error;
    }
    let correction;
    let result;
    try {
      correction = await new DatasetCorrectionService().interpret({
        facts: context.datasetFacts,
        understanding: context.datasetUnderstanding,
        message: action.text,
      });
      result = await workflow.resume({
        runId,
        runtimeDb,
        datasetConfirmation: correction.draft,
      });
    } catch (error) {
      recordFailedRunAction(runtimeDb, runId, '数据修正', error);
      throw error;
    }
    const correctedContext = await workflow.conversationContext(runId, runtimeDb);
    const store = new SQLiteConversationStore(runtimeDb);
    try {
      const sessionId = `theta-web-${runId}`;
      store.getOrCreateSession(sessionId, { activeRunId: runId });
      store.appendMessage({
        messageId: `message.assistant.${randomUUID()}`,
        sessionId,
        runId,
        role: 'assistant',
        messageKind: 'dataset.correction-applied',
        content: `已应用数据理解纠正：${correction.correctionSummary}`,
        createdAt: new Date().toISOString(),
      });
      if (correctedContext.decisionGap) {
        store.appendMessage({
          messageId: `message.assistant.${randomUUID()}`,
          sessionId,
          runId,
          role: 'assistant',
          messageKind: 'research.decision-gap',
          content: correctedContext.decisionGap.question,
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      store.close();
    }
    return result;
  }
  if (action.action === 'decisionAnswer') {
    appendRunMessage(runtimeDb, runId, 'user', 'research.decision-answer', action.text);
    let result;
    try {
      result = await workflow.resume({
        runId,
        runtimeDb,
        decisionAnswer: action.text,
      });
    } catch (error) {
      recordFailedRunAction(runtimeDb, runId, '研究意图更新', error);
      throw error;
    }
    const context = await workflow.conversationContext(result.runId, runtimeDb);
    const store = new SQLiteConversationStore(runtimeDb);
    try {
      const sessionId = `theta-web-${result.runId}`;
      store.getOrCreateSession(sessionId, { activeRunId: result.runId });
      if (context.decisionGap) {
        store.appendMessage({
          messageId: `message.assistant.${randomUUID()}`,
          sessionId,
          runId: result.runId,
          role: 'assistant',
          messageKind: 'research.decision-gap',
          content: context.decisionGap.question,
          createdAt: new Date().toISOString(),
        });
      } else if (context.researchIntentSummary) {
        store.appendMessage({
          messageId: `message.assistant.${randomUUID()}`,
          sessionId,
          runId: result.runId,
          role: 'assistant',
          messageKind: 'research.intent-summary',
          content: formatWebIntentSummary(context.researchIntentSummary),
          createdAt: new Date().toISOString(),
        });
      } else {
        store.appendMessage({
          messageId: `message.assistant.${randomUUID()}`,
          sessionId,
          runId: result.runId,
          role: 'assistant',
          messageKind: context.status.status === 'failed'
            ? 'workflow.failed'
            : isAutonomousDelegationAnswer(action.text)
            ? 'research.delegation-applied'
            : 'research.intent-complete',
          content: context.status.status === 'failed'
            ? `研究意图已保存，但后续工作流执行失败：${context.status.pendingReason ?? '请查看状态详情后重试。'}`
            : isAutonomousDelegationAnswer(action.text)
            ? '已根据数据证据和系统建议补全剩余研究设置。接下来请审核训练方案；批准方案不会直接启动训练。'
            : context.status.currentState === 'AwaitPlanCreationApproval'
              ? '研究意图已经明确。MiniMax 已依据数据事实、能力目录和 RAG 证据形成可执行方案；请审核方案，批准方案不会直接启动训练。'
              : '研究意图已经明确；请查看当前状态和下一步提示。',
          createdAt: new Date().toISOString(),
        });
      }
    } finally {
      store.close();
    }
    return result;
  }
  if (action.action === 'confirmIntent') {
    appendRunMessage(runtimeDb, runId, 'user', 'research.intent-confirmation', '确认研究意图摘要。');
    const status = await workflow.status(runId, runtimeDb);
    if (status.pendingActionRef !== THETA_APPROVAL_KEYS.researchIntentReview) {
      throw new Error('当前不是研究意图确认阶段。');
    }
    const result = await workflow.resume({
      runId,
      runtimeDb,
      approve: true,
      approvedBy: 'local_user',
    });
    appendRunMessage(
      runtimeDb,
      runId,
      'assistant',
      'research.intent-confirmed',
      '研究意图已确认，正在基于数据事实、模型能力和 RAG 证据生成方案。',
    );
    return result;
  }
  const store = new SQLiteConversationStore(runtimeDb);
  try {
    const sessionId = `theta-web-${runId}`;
    if (action.action === 'message') {
      store.getOrCreateSession(sessionId, { activeRunId: runId });
      store.updateSession(sessionId, {
        languageConsent: action.useMiniMax,
        providerMode: action.useMiniMax ? 'minimax' : 'deterministic',
      });
    }
    const orchestrator = new ThetaTurnOrchestrator(store, workflow);
    const command = action.action === 'answer'
      ? { kind: 'answer' as const, text: action.text }
      : action.action === 'message'
        ? { kind: 'natural' as const, text: action.text }
      : action.action === 'columns'
        ? { kind: 'columns' as const, text: action.text }
        : action.action === 'finishInterview'
          ? { kind: 'done' as const }
          : action.action === 'adjustPlan'
            ? { kind: 'adjust' as const, text: action.text }
            : action.action === 'approvePlan'
              ? {
                  kind: 'approvePlan' as const,
                  acceptDegradation: action.acceptDegradation,
                }
              : { kind: 'startTraining' as const };
    const result = await orchestrator.execute(command, {
      sessionId,
      activeRunId: runId,
      runtimeDb,
    });
    return result.value;
  } finally {
    store.close();
  }
};

const toTimelineEntry = (event: {
  id: string;
  type: string;
  timestamp: string;
  payload: unknown;
}): ThetaWebTimelineEntry => {
  const payload = asRecord(event.payload);
  const state = stringField(payload, 'stateId') ?? stringField(payload, 'toStateId');
  const toolId = stringField(payload, 'toolId');
  const labels: Record<string, string> = {
    'run.started': '研究任务已创建',
    'run.completed': '研究训练已完成',
    'run.failed': '研究任务运行失败',
    'run.waiting_human': '等待你的确认',
    'run.waiting_timer': '等待下一次训练状态检查',
    'fsm.state.entered': state ? `进入 ${humanState(state)}` : '进入下一阶段',
    'fsm.state.exited': state ? `完成 ${humanState(state)}` : '完成当前阶段',
    'fsm.transition.accepted': 'FSM 已确认状态迁移',
    'timer.fired': '训练监控定时器已触发',
    'tool.call.started': toolId ? `开始执行 ${toolId}` : '开始执行受治理工具',
    'tool.call.completed': toolId ? `${toolId} 执行完成` : '受治理工具执行完成',
    'tool.call.failed': toolId ? `${toolId} 执行失败` : '受治理工具执行失败',
    'tool.policy.checked': toolId ? `已校验 ${toolId} 权限` : '已完成工具权限校验',
    'tool.output.validated': '工具输出已通过契约校验',
    'tool.invocation.state.changed': '工具调用状态已更新',
  };
  return {
    id: event.id,
    source: event.type.startsWith('tool.') ? 'tool' : 'workflow',
    type: event.type,
    title: labels[event.type] ?? event.type,
    ...(state ? { detail: `状态：${humanState(state)}` } : toolId ? { detail: `工具：${toolId}` } : {}),
    timestamp: event.timestamp,
  };
};

const humanState = (state: string): string => ({
  Intake: '接收研究任务',
  ResearchClarification: '完善研究设置',
  InspectDataset: '检查数据集',
  ColumnConfirmation: '确认数据列',
  RecommendModel: '生成模型建议',
  ValidatePlan: '校验训练方案',
  AwaitPlanCreationApproval: '等待方案审批',
  CreatePlan: '固化训练方案',
  DryRun: '训练前检查',
  AwaitTrainingStartApproval: '等待启动审批',
  VerifyDatasetBeforeTraining: '训练前复核数据',
  StartTraining: '启动模型训练',
  MonitorTraining: '跟踪训练进度',
  Completed: '训练完成',
  Failed: '运行失败',
  Cancelled: '训练已取消',
  Quarantined: '运行已隔离',
} as Record<string, string>)[state] ?? state;

const buildRunIdentity = (value: unknown): Record<string, unknown> => {
  const plan = asRecord(value) ?? {};
  const brief = asRecord(plan.researchBrief) ?? {};
  const dataSource = Array.isArray(brief.dataSources)
    ? brief.dataSources.find((item): item is string => typeof item === 'string')
    : undefined;
  const datasetName = dataSource
    ? path.basename(dataSource, path.extname(dataSource))
    : stringField(asRecord(plan.datasetProfile), 'datasetId') ?? '本地数据集';
  const researchQuestion = normalizeResearchQuestion(
    stringField(brief, 'researchQuestion'),
  ) ?? '主题分析';
  const canonicalPlan = asRecord(asRecord(plan.planRecord)?.canonicalPlan);
  const model = asRecord(canonicalPlan?.model) ?? asRecord(plan.validatedPlan) ?? asRecord(plan.candidatePlan);
  const modelId = stringField(model, 'modelId');
  const numTopics = typeof model?.numTopics === 'number' ? model.numTopics : undefined;
  const compactQuestion = researchQuestion.replace(/\s+/gu, ' ').trim();
  const purpose = /主题|topic/iu.test(compactQuestion)
    ? /时间|趋势|演化|temporal|trend/iu.test(compactQuestion)
      ? '主题识别与趋势分析'
      : '主题识别分析'
    : compactQuestion.length > 20
      ? `${compactQuestion.slice(0, 20)}…`
      : compactQuestion;
  return {
    datasetName,
    researchQuestion,
    displayName: `${datasetName} · ${purpose}`,
    ...(modelId ? { modelId } : {}),
    ...(numTopics !== undefined ? { numTopics } : {}),
  };
};

const normalizeResearchQuestion = (value?: string): string | undefined => {
  if (!value) return undefined;
  const normalized = value
    .replace(/[，,、；;\s]+(?=[，,、；;])/gu, '')
    .replace(/([，,、；;])\1+/gu, '$1')
    .replace(/^[，,、；;\s]+|[，,、；;\s]+$/gu, '')
    .trim();
  return normalized || undefined;
};

export const isUserFacingRun = (value: unknown): boolean => {
  const run = asRecord(value) ?? {};
  const runId = stringField(run, 'runId') ?? '';
  const identity = asRecord(run.identity) ?? {};
  const datasetName = (stringField(identity, 'datasetName') ?? '').toLowerCase();
  if (runId.startsWith('theta-stage-')) return false;
  return datasetName !== 'sample' && datasetName !== 'recommendation-sample';
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = asRecord(value)?.[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
};

const listDatasets = async (
  agentRoot: string,
  runtimeDb: string,
): Promise<Array<ReturnType<typeof presentDataset>>> => {
  const roots = [path.join(agentRoot, 'fixtures'), path.join(agentRoot, '..', 'THETA', 'data')];
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  for (const [rootIndex, root] of roots.entries()) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(csv|tsv|json|jsonl|txt|xlsx|xls|parquet)$/iu.test(entry.name)) continue;
      if (rootIndex === 0 && entry.name.toLowerCase().endsWith('.json')) continue;
      const resolved = await resolveDatasetFile(path.join(root, entry.name));
      await registry.registerLocalFile(resolved.filePath, localOwner);
    }
  }
  try {
    return registry.list(localOwner)
      .map(presentDataset)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  } finally {
    registry.close();
  }
};

const presentDataset = (dataset: DatasetRecord) => ({
  datasetRef: dataset.datasetRef,
  name: dataset.displayName,
  sizeBytes: dataset.sizeBytes,
  suffix: dataset.suffix,
  createdAt: dataset.createdAt,
});

const persistInitialDatasetConversation = (
  runtimeDb: string,
  runId: string,
  facts: DatasetFacts | undefined,
  understanding: DatasetUnderstandingDraft | undefined,
  researchGoal: string,
): void => {
  const store = new SQLiteConversationStore(runtimeDb);
  try {
    const sessionId = `theta-web-${runId}`;
    store.getOrCreateSession(sessionId, { activeRunId: runId });
    store.appendMessage({
      messageId: `message.user.${randomUUID()}`,
      sessionId,
      runId,
      role: 'user',
      messageKind: 'research.initial-direction',
      content: researchGoal,
      createdAt: new Date().toISOString(),
    });
    if (!facts || !understanding) return;
    store.appendMessage({
      messageId: `message.assistant.${randomUUID()}`,
      sessionId,
      runId,
      role: 'assistant',
      messageKind: 'dataset.understanding-review',
      content: [
        `我已检查数据：共 ${facts.rowCount} 行、${facts.columns.length} 列。`,
        `列名：${facts.columns.map((column) => column.name).join('、')}。`,
        `初步判断这是${understanding.domain.label}数据；分析单位是${understanding.analysisUnit}。`,
        `建议正文列为 ${understanding.textColumns.map((item) => item.column).join('、') || '尚未确定'}。`,
        '请确认以上理解；如有错误，可以直接用自然语言指出。',
      ].join(' '),
      createdAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
};

const storeUploadedDataset = async (
  request: IncomingMessage,
  agentRoot: string,
  runtimeDb: string,
): Promise<DatasetRecord> => {
  const maxBytes = configuredUploadLimit();
  const contentLength = Number.parseInt(request.headers['content-length'] ?? '0', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes + 1024 * 1024) {
    throw new SyntaxError(`上传内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制。`);
  }
  const file = await multipartFile(request);
  if (file.size === 0) throw new SyntaxError('上传的数据集为空。');
  if (file.size > maxBytes) {
    throw new SyntaxError(`数据集超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制。`);
  }
  const originalName = safeDatasetName(file.name);
  const suffix = path.extname(originalName).toLowerCase();
  if (!supportedUploadSuffixes.has(suffix)) {
    throw new SyntaxError(`不支持 ${suffix || '无扩展名'} 数据集。`);
  }
  const content = Buffer.from(await file.arrayBuffer());
  const digest = createHash('sha256').update(content).digest('hex');
  const uploadRoot = path.resolve(agentRoot, '..', 'THETA', 'data', '.theta_uploads');
  await mkdir(uploadRoot, { recursive: true });
  const managedPath = path.join(uploadRoot, `${digest.slice(0, 16)}-${originalName}`);
  await writeFile(managedPath, content, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  try {
    return await registry.registerLocalFile(managedPath, localOwner);
  } catch (error) {
    await rm(managedPath, { force: true });
    throw error;
  } finally {
    registry.close();
  }
};

const multipartFile = async (request: IncomingMessage): Promise<File> => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const webRequest = new Request('http://theta.local/upload', {
    method: 'POST',
    headers,
    body: Readable.toWeb(request) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const value = (await webRequest.formData()).get('file');
  if (!(value instanceof File)) throw new SyntaxError('multipart 请求必须包含 file 字段。');
  return value;
};

const safeDatasetName = (value: string): string => {
  const normalized = path.basename(value).replace(/[^\p{L}\p{N}._-]+/gu, '-');
  return normalized.slice(-180) || `dataset-${randomUUID()}.csv`;
};

const configuredUploadLimit = (): number => {
  const parsed = Number.parseInt(process.env.THETA_MAX_DATASET_BYTES ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 100 * 1024 * 1024;
};

const removeRunResultArtifacts = async (
  resultRoot: string | undefined,
  agentRoot: string,
): Promise<boolean> => {
  if (!resultRoot) return false;
  const allowedRoot = path.resolve(agentRoot, '..', 'THETA', 'result');
  const candidate = path.resolve(resultRoot);
  const relative = path.relative(allowedRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  await rm(candidate, { recursive: true, force: true });
  return true;
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('请求内容超过 64KB 限制。');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const methodNotAllowed = (response: ServerResponse): void => {
  writeJson(response, 405, {
    ok: false,
    error: {
      code: 'THETA_WEB_API_METHOD_NOT_ALLOWED',
      message: '当前接口不允许该操作。',
    },
  });
};

const boundedLimit = (value: string | null): number => {
  const parsed = value ? Number.parseInt(value, 10) : 30;
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 30;
};

const formatWebIntentSummary = (
  summary: NonNullable<ThetaWorkflowConversationContext['researchIntentSummary']>,
): string => [
  '请确认研究意图摘要：',
  `研究问题：${summary.researchQuestion}`,
  `比较用途：${summary.comparison.enabled
    ? `${summary.comparison.dimensions.join('、')}（${summary.comparison.purpose === 'model' ? '进入模型估计' : '仅用于结果展示'}）`
    : '不比较'}`,
  `时间用途：${summary.temporal.enabled
    ? `${summary.temporal.columns.join('、') || '时间列'}（${summary.temporal.purpose === 'topic_evolution' ? '模型学习主题演化' : '训练后绘制趋势'}）`
    : '不做时间分析'}`,
  `主题粒度：${summary.topicGranularity === 'coarse' ? '少量宽泛主题' : summary.topicGranularity === 'fine' ? '更多细粒度主题' : '中等粒度'}`,
  `成功标准：${summary.successCriteria.join('；') || '采用系统建议'}`,
  `交付内容：${summary.deliverables.join('、') || '主题表、关键词和代表文本'}`,
  `约束：${summary.constraints.join('；') || '无额外约束'}`,
  '确认后再生成方案；需要修改时可直接用自然语言说明。',
].join('\n');

const parsePort = (value: string | undefined): number => {
  const parsed = value ? Number.parseInt(value, 10) : 4318;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('THETA_WEB_API_PORT must be an integer between 1 and 65535.');
  }
  return parsed;
};

const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
};

if (isDirectExecution()) {
  const options = resolveThetaWebApiOptions();
  createThetaWebApiServer(options).listen(options.port, options.host, () => {
    console.log(`THETA 2.0 Agent API listening on http://${options.host}:${options.port}`);
  });
}
