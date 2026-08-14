import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { ThetaTurnOrchestrator } from '@theta-agent/agent';
import { isAutonomousDelegationAnswer } from '@theta-agent/agent';
import { DatasetCorrectionService } from '@theta-agent/agent';
import type {
  DatasetFacts,
  DatasetUnderstandingDraft,
} from '@theta-agent/agent';
import { DoctorService } from '@theta-agent/agent';
import { ModelSelectionService } from '@theta-agent/agent';
import { loadThetaProjectEnvironment } from '@theta-agent/agent';
import { buildHumanResponse } from '@theta-agent/agent';
import { ResultAnalysisService } from '@theta-agent/agent';
import { ResultService } from '@theta-agent/agent';
import { deleteLocalRun, listLocalRuns, pinLocalRun, renameLocalRun } from '@theta-agent/agent';
import { SQLiteConversationStore } from '@theta-agent/agent';
import { SQLiteDatasetRegistry, type DatasetRecord } from '@theta-agent/agent';
import { THETA_APPROVAL_KEYS } from '@theta-agent/agent';
import {
  ThetaWorkflowService,
  type ThetaWorkflowConversationContext,
} from '@theta-agent/agent';
import { resolveDatasetFile } from '@theta-agent/agent';
import { runThetaModelCatalog } from '@theta-agent/agent';
import { runThetaTrainingStatus } from '@theta-agent/agent';
import { getThetaRuntimeProfile } from '@theta-agent/agent';
import { buildThetaAgentInteraction, buildThetaWorkspaceInteraction } from '@theta-agent/agent';
import {
  thetaResultAnalysisRequestSchema,
  thetaWebCreateRunSchema,
  thetaWebInferenceSelectionSchema,
  thetaWebInferenceSettingsSchema,
  thetaWebPostMessageSchema,
  thetaWebHistoryUpdateSchema,
  thetaWebRunActionSchema,
  type ThetaWebApiEnvelope,
  type ThetaWebApiHealth,
  type ThetaWebConversationMessage,
  type ThetaWebReasoning,
  type ThetaWebReasoningToolCall,
  type ThetaWebRunAction,
  type ThetaWebRunEvent,
  type ThetaWebStreamEvent,
  type ThetaWebTimelineEntry,
} from '@theta-agent/agent/api/contracts.js';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultAgentRoot = path.resolve(moduleDirectory, '..', '..', '..');
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
      if (response.headersSent) {
        if (!response.writableEnded) response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      writeCors(response, request.headers.origin);
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
  writeCors(response, request.headers.origin);

  if (method === 'OPTIONS') {
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

  if (url.pathname === '/api/v2/runtime') {
    if (method !== 'GET') return methodNotAllowed(response);
    writeJson(response, 200, { ok: true, data: await getThetaRuntimeProfile() });
    return;
  }

  if (url.pathname === '/api/v2/workspace/sessions') {
    if (method === 'GET') {
      const store = new SQLiteConversationStore(options.runtimeDb);
      try {
        writeJson(response, 200, {
          ok: true,
          data: { sessions: store.listWorkspaceSessions(boundedLimit(url.searchParams.get('limit'))) },
        });
      } finally {
        store.close();
      }
      return;
    }
    if (method !== 'POST') return methodNotAllowed(response);
    const sessionId = `theta-web-workspace-${randomUUID()}`;
    const store = new SQLiteConversationStore(options.runtimeDb);
    try {
      store.getOrCreateSession(sessionId);
      writeJson(response, 201, {
        ok: true,
        data: { sessionId, interaction: buildThetaWorkspaceInteraction() },
      });
    } finally {
      store.close();
    }
    return;
  }

  const workspaceSessionMatch = url.pathname.match(/^\/api\/v2\/workspace\/sessions\/([^/]+)$/);
  if (workspaceSessionMatch) {
    const sessionId = decodeURIComponent(workspaceSessionMatch[1]);
    if (!sessionId.startsWith('theta-web-workspace-')) throw new SyntaxError('Invalid workspace session.');
    const store = new SQLiteConversationStore(options.runtimeDb);
    try {
      if (method === 'PATCH') {
        const input = thetaWebHistoryUpdateSchema.parse(await readJsonBody(request));
        writeJson(response, 200, {
          ok: true,
          data: 'displayName' in input
            ? store.renameSession(sessionId, input.displayName)
            : store.pinSession(sessionId, input.pinned),
        });
        return;
      }
      if (method === 'DELETE') {
        const deleted = store.deleteSession(sessionId);
        writeJson(response, deleted ? 200 : 404, deleted
          ? { ok: true, data: { sessionId } }
          : { ok: false, error: { code: 'THETA_WORKSPACE_SESSION_NOT_FOUND', message: 'Conversation not found.' } });
        return;
      }
      return methodNotAllowed(response);
    } finally {
      store.close();
    }
  }

  const workspaceConversationMatch = url.pathname.match(
    /^\/api\/v2\/workspace\/sessions\/([^/]+)\/conversation$/,
  );
  if (workspaceConversationMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const sessionId = decodeURIComponent(workspaceConversationMatch[1]);
    if (!sessionId.startsWith('theta-web-workspace-')) throw new SyntaxError('Invalid workspace session.');
    const store = new SQLiteConversationStore(options.runtimeDb);
    try {
      store.getOrCreateSession(sessionId);
      const messages = store
        .listRecentMessages(sessionId, boundedLimit(url.searchParams.get('limit')))
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map(presentConversationMessage);
      writeJson(response, 200, {
        ok: true,
        data: {
          sessionId,
          messages,
          memory: store.getMemory(sessionId) ?? store.refreshMemory(sessionId),
          tokenUsage: store.getTokenUsage(sessionId),
          interaction: buildThetaWorkspaceInteraction(),
        },
      });
    } finally {
      store.close();
    }
    return;
  }

  const workspaceMessageMatch = url.pathname.match(
    /^\/api\/v2\/workspace\/sessions\/([^/]+)\/messages$/,
  );
  if (workspaceMessageMatch) {
    if (method !== 'POST') return methodNotAllowed(response);
    const sessionId = decodeURIComponent(workspaceMessageMatch[1]);
    if (!sessionId.startsWith('theta-web-workspace-')) throw new SyntaxError('Invalid workspace session.');
    const input = thetaWebPostMessageSchema.parse(await readJsonBody(request));
    const store = new SQLiteConversationStore(options.runtimeDb);
    try {
      const before = new Set(
        store.listRecentMessages(sessionId, 100).map((message) => message.messageId),
      );
      store.getOrCreateSession(sessionId);
      store.updateSession(sessionId, {
        languageConsent: languageProviderEnabled(input),
        providerMode: languageProviderEnabled(input) ? 'provider' : 'deterministic',
      });
      const result = await new ThetaTurnOrchestrator(store, workflow).execute(
        { kind: 'natural', text: input.text },
        { sessionId, runtimeDb: options.runtimeDb },
      );
      const value = asRecord(result.value) ?? {};
      if (before.size === 0) store.renameSession(sessionId, input.text.slice(0, 64));
      const proposal = asRecord(value.proposal);
      const requestDataset = proposal?.intent === 'needs_dataset';
      const messages = store
        .listRecentMessages(sessionId, 100)
        .filter((message) => !before.has(message.messageId))
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map(presentConversationMessage);
      writeJson(response, 200, {
        ok: true,
        data: {
          sessionId,
          messages,
          memory: store.getMemory(sessionId),
          tokenUsage: store.getTokenUsage(sessionId),
          activity: {
            proposal: value.proposal,
            result: value.result,
            evidenceRefs: value.evidenceRefs,
          },
          interaction: buildThetaWorkspaceInteraction(
            requestDataset,
            requestDataset
              ? 'The user intent requires analysis of data that is not registered yet.'
              : 'The current request can be answered without registering a dataset.',
          ),
        },
      });
    } finally {
      store.close();
    }
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
          plannerMode: languageProviderEnabled(input) ? 'provider' : 'deterministic',
          allowRemoteSamples: input.allowRemoteSamples,
        },
        runtimeDb: options.runtimeDb,
      });
      const initialContext = await workflow.conversationContext(result.runId, options.runtimeDb);
      if (input.sourceSessionId) {
        promoteWorkspaceConversation(options.runtimeDb, input.sourceSessionId, result.runId);
      }
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
          const identity = buildRunIdentity(plan);
          return {
            ...run,
            status: status.status,
            currentState: status.currentState,
            pendingReason: status.pendingReason,
            lastEventType: status.lastEventType,
            lastEventAt: status.lastEventAt,
            presentation: buildHumanResponse(status),
            identity: run.displayName ? { ...identity, displayName: run.displayName } : identity,
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
  if (runMatch && method === 'PATCH') {
    const runId = decodeURIComponent(runMatch[1]);
    const input = thetaWebHistoryUpdateSchema.parse(await readJsonBody(request));
    writeJson(response, 200, {
      ok: true,
      data: 'displayName' in input
        ? renameLocalRun(runId, input.displayName, options.runtimeDb)
        : pinLocalRun(runId, input.pinned, options.runtimeDb),
    });
    return;
  }
  if ((compatibilityRunDeleteMatch || runMatch) && method !== 'GET') {
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

  if (url.pathname === '/api/v2/inference') {
    const selection = new ModelSelectionService();
    if (method === 'GET') {
      writeJson(response, 200, { ok: true, data: selection.execute({ action: 'list' }) });
      return;
    }
    if (method === 'POST') {
      const input = thetaWebInferenceSelectionSchema.parse(await readJsonBody(request));
      writeJson(response, 200, { ok: true, data: selection.execute(input) });
      return;
    }
    return methodNotAllowed(response);
  }

  if (url.pathname === '/api/v2/inference/settings') {
    const selection = new ModelSelectionService();
    if (method === 'GET') {
      writeJson(response, 200, { ok: true, data: selection.settings() });
      return;
    }
    if (method === 'PATCH') {
      const input = thetaWebInferenceSettingsSchema.parse(await readJsonBody(request));
      writeJson(response, 200, { ok: true, data: selection.configure(input) });
      return;
    }
    return methodNotAllowed(response);
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
        interaction: buildThetaAgentInteraction(status),
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
      writeJson(response, 200, {
        ok: true,
        data: {
          runId,
          messages,
          memory: store.getMemory(`theta-web-${runId}`) ?? store.refreshMemory(`theta-web-${runId}`),
          tokenUsage: store.getTokenUsage(`theta-web-${runId}`),
        },
      });
    } finally {
      store.close();
    }
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/messages$/);
  if (messageMatch) {
    if (method !== 'POST') return methodNotAllowed(response);
    const runId = decodeURIComponent(messageMatch[1]);
    const input = thetaWebPostMessageSchema.parse(await readJsonBody(request));
    const store = new SQLiteConversationStore(options.runtimeDb);
    try {
      const sessionId = `theta-web-${runId}`;
      const before = new Set(
        store.listRecentMessages(sessionId, 200).map((message) => message.messageId),
      );
      store.getOrCreateSession(sessionId, { activeRunId: runId });
      store.updateSession(sessionId, {
        languageConsent: languageProviderEnabled(input),
        providerMode: languageProviderEnabled(input) ? 'provider' : 'deterministic',
      });
      if (input.attachments.length > 0) {
        appendRunMessage(
          options.runtimeDb,
          runId,
          'user',
          'result.analysis.question',
          input.text,
        );
        appendRunMessage(
          options.runtimeDb,
          runId,
          'assistant',
          'activity.artifacts.viewed',
          JSON.stringify({ attachments: input.attachments }),
        );
        const analysis = await new ResultAnalysisService(workflow).analyze(
          runId,
          options.runtimeDb,
          {
            question: input.text,
            selection: {
              topicIds: input.attachments.filter((item) => item.kind === 'topic').map((item) => item.id),
              metricKeys: input.attachments.filter((item) => item.kind === 'metric').map((item) => item.id),
              visualizationIds: input.attachments.filter((item) => item.kind === 'visualization').map((item) => item.id),
              includeGoalAssessment: input.attachments.some((item) => item.kind === 'table'),
              includeWarnings: true,
            },
            history: store
              .listRecentMessages(sessionId, 8)
              .filter((message): message is typeof message & { role: 'user' | 'assistant' } =>
                message.role === 'user' || message.role === 'assistant')
              .map((message) => ({ role: message.role, content: message.content })),
          },
        );
        store.recordLanguageInterpretation({
          interpretationId: `interpretation.${randomUUID()}`,
          sessionId,
          runId,
          task: 'explain_selected_results',
          provider: 'provider',
          requestHash: createHash('sha256')
            .update(JSON.stringify({ question: input.text, attachments: input.attachments }))
            .digest('hex'),
          responseHash: createHash('sha256').update(analysis.answer).digest('hex'),
          structuredOutput: {
            telemetry: {
              providerId: analysis.provider,
              model: analysis.model,
              ...(analysis.usage ?? {}),
            },
            output: { answer: analysis.answer },
          },
          status: 'completed',
          createdAt: new Date().toISOString(),
        });
        appendRunMessage(
          options.runtimeDb,
          runId,
          'assistant',
          'result.analysis.response',
          analysis.answer,
        );
        const messages = store
          .listRecentMessages(sessionId, 200)
          .filter((message) => !before.has(message.messageId) && message.runId === runId)
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map(presentConversationMessage);
        const status = await workflow.status(runId, options.runtimeDb);
        writeJson(response, 200, {
          ok: true,
          data: {
            runId,
            activeRunId: runId,
            messages,
            status: presentRun(status),
            tokenUsage: store.getTokenUsage(sessionId),
          },
        });
        return;
      }
      const orchestrator = new ThetaTurnOrchestrator(store, workflow);
      const result = await orchestrator.execute(
        { kind: 'natural', text: input.text },
        { sessionId, activeRunId: runId, runtimeDb: options.runtimeDb },
      );
      const activeRunId = typeof result.activeRunId === 'string' && result.activeRunId
        ? result.activeRunId
        : runId;
      const messages = store
        .listRecentMessages(sessionId, 200)
        .filter((message) => !before.has(message.messageId) && message.runId === activeRunId)
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map(presentConversationMessage);
      const status = await workflow.status(activeRunId, options.runtimeDb);
      writeJson(response, 200, {
        ok: true,
        data: {
          runId,
          activeRunId,
          messages,
          status: presentRun(status),
          tokenUsage: store.getTokenUsage(sessionId),
        },
      });
    } finally {
      store.close();
    }
    return;
  }

  const eventsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events$/);
  if (eventsMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(eventsMatch[1]);
    const after = url.searchParams.get('after') ?? undefined;
    const limit = boundedLimit(url.searchParams.get('limit'));
    const evidence = await workflow.evidence(runId, options.runtimeDb);
    const all = normalizeRunEvents(evidence);
    let events = all;
    if (after) {
      const index = events.findIndex((event) => event.id === after);
      if (index >= 0) events = events.slice(index + 1);
    }
    events = events.slice(-limit);
    writeJson(response, 200, {
      ok: true,
      data: { runId, events, count: events.length, total: all.length },
    });
    return;
  }

  const reasoningMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/reasoning$/);
  if (reasoningMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(reasoningMatch[1]);
    writeJson(response, 200, {
      ok: true,
      data: await buildReasoning(runId, options.runtimeDb, workflow),
    });
    return;
  }

  const streamMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/stream$/);
  if (streamMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(streamMatch[1]);
    void runStream(response, runId, options, workflow);
    return;
  }

  const runDetailMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
  if (runDetailMatch && method === 'GET') {
    const runId = decodeURIComponent(runDetailMatch[1]);
    const [status, plan, results] = await Promise.all([
      workflow.status(runId, options.runtimeDb),
      workflow.plan(runId, options.runtimeDb).catch(() => undefined),
      new ResultService(workflow).overview(runId, options.runtimeDb).catch(() => undefined),
    ]);
    writeJson(response, 200, {
      ok: true,
      data: {
        runId,
        status: presentRun(status),
        identity: plan ? buildRunIdentity(plan) : undefined,
        ...(plan
          ? { plan: { ...plan, runtimeDb: undefined, presentation: buildHumanResponse(plan) } }
          : {}),
        ...(results ? { results } : {}),
      },
    });
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

  const resultArchiveMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/results\/archive$/);
  if (resultArchiveMatch) {
    if (method !== 'GET') return methodNotAllowed(response);
    const runId = decodeURIComponent(resultArchiveMatch[1]);
    const results = await new ResultService(workflow).overview(runId, options.runtimeDb);
    if (!results.resultRoot) throw new Error('当前任务没有可打包的结果目录。');
    await writeResultArchive(response, results.resultRoot, runId);
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

  if (!url.pathname.startsWith('/api/')) {
    await serveWebAsset(response, url.pathname, options.agentRoot);
    return;
  }

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
    ...(extension === '.html' ? { 'Content-Security-Policy': 'sandbox allow-scripts' } : {}),
  });
  response.end(content);
};

const writeResultArchive = async (
  response: ServerResponse,
  resultRoot: string,
  runId: string,
): Promise<void> => {
  const root = path.resolve(resultRoot);
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error('The result archive source is not a directory.');
  writeCors(response);
  response.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="theta-results-${runId.replace(/[^a-z0-9._-]/giu, '_')}.tar.gz"`,
    'X-Content-Type-Options': 'nosniff',
  });
  await new Promise<void>((resolve, reject) => {
    const archive = spawn('tar', ['-czf', '-', '-C', root, '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    archive.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    archive.on('error', reject);
    archive.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Result archive failed (${String(code)}): ${stderr}`));
    });
    archive.stdout.pipe(response);
  });
};

const writeCors = (response: ServerResponse, origin?: string): void => {
  const configured = (process.env.THETA_WEB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set([
    'http://127.0.0.1:4318',
    'http://localhost:4318',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    ...configured,
  ]);
  if (origin && allowed.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Cache-Control', 'no-store');
};

const WEB_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** Serves the built @theta-agent/web application (SPA with index fallback). */
const serveWebAsset = async (
  response: ServerResponse,
  requestPath: string,
  agentRoot: string,
): Promise<void> => {
  const webRoot = path.join(agentRoot, 'apps', 'web', 'dist');
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const candidate = path.resolve(webRoot, relativePath);
  const boundary = path.relative(webRoot, candidate);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
    writeJson(response, 404, {
      ok: false,
      error: { code: 'THETA_WEB_API_NOT_FOUND', message: 'The requested THETA 2.0 API route does not exist.' },
    });
    return;
  }
  let filePath = candidate;
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) filePath = path.join(webRoot, 'index.html');
  } catch {
    filePath = path.join(webRoot, 'index.html');
  }
  try {
    const content = await readFile(filePath);
    writeCors(response);
    response.writeHead(200, {
      'Content-Type': WEB_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(content.byteLength),
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  } catch {
    writeJson(response, 404, {
      ok: false,
      error: { code: 'THETA_WEB_API_NOT_FOUND', message: 'Web 前端尚未构建。请先运行 npm run build:web。' },
    });
  }
};

const presentRun = (value: unknown): Record<string, unknown> => {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    ...record,
    runtimeDb: undefined,
    presentation: buildHumanResponse(value),
    interaction: buildThetaAgentInteraction(value),
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
    store.refreshMemory(sessionId);
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
              ? '研究意图已经明确。语言模型已依据数据事实、能力目录和 RAG 证据形成可执行方案；请审核方案，批准方案不会直接启动训练。'
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
  if (action.action === 'reject') {
    appendRunMessage(runtimeDb, runId, 'user', 'human.review.rejected', action.reason);
    const result = await workflow.resume({
      runId,
      runtimeDb,
      reject: true,
      approvedBy: 'local_user',
    });
    appendRunMessage(
      runtimeDb,
      runId,
      'assistant',
      'human.review.rejection-recorded',
      '已记录拒绝原因，Agent 不会继续执行该审批动作。',
    );
    return result;
  }
  const store = new SQLiteConversationStore(runtimeDb);
  try {
    const sessionId = `theta-web-${runId}`;
    if (action.action === 'message') {
      store.getOrCreateSession(sessionId, { activeRunId: runId });
      store.updateSession(sessionId, {
        languageConsent: languageProviderEnabled(action),
        providerMode: languageProviderEnabled(action) ? 'provider' : 'deterministic',
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

const EVENT_TITLES: Record<string, string> = {
  'run.started': '研究任务已创建',
  'run.completed': '研究训练已完成',
  'run.failed': '研究任务运行失败',
  'run.waiting_human': '等待你的确认',
  'run.waiting_timer': '等待下一次训练状态检查',
  'fsm.state.entered': '进入下一阶段',
  'fsm.state.exited': '完成当前阶段',
  'fsm.transition.accepted': 'FSM 已确认状态迁移',
  'timer.fired': '训练监控定时器已触发',
  'tool.call.requested': '请求执行受治理工具',
  'tool.call.started': '开始执行受治理工具',
  'tool.call.completed': '受治理工具执行完成',
  'tool.call.failed': '受治理工具执行失败',
  'tool.call.approved': '工具调用已获批',
  'tool.call.rejected': '工具调用被拒绝',
  'tool.policy.checked': '已完成工具权限校验',
  'tool.output.validated': '工具输出已通过契约校验',
  'tool.invocation.state.changed': '工具调用状态已更新',
  'thinking.started': '开始思考',
  'thinking.completed': '思考完成',
  'agent.deliberation.started': '开始规划',
  'agent.deliberation.completed': '规划完成',
  'agent.reasoning.started': '开始推理',
  'agent.reasoning.completed': '推理完成',
  'reasoning.decision.recorded': '记录推理决策',
  'agent.action.selected': '选定下一步动作',
  'inference.requested': '发起语言推理',
  'inference.completed': '语言推理完成',
  'inference.failed': '语言推理失败',
  'model.call.completed': '模型调用完成',
  'human.review.requested': '等待人工审批',
  'human.review.approved': '人工审批通过',
  'human.review.rejected': '人工审批驳回',
  'human.review.resolved': '人工审批已处理',
};

const REASONING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'thinking.started',
  'thinking.completed',
  'agent.deliberation.started',
  'agent.deliberation.completed',
  'agent.reasoning.started',
  'agent.reasoning.completed',
  'reasoning.decision.recorded',
  'agent.action.selected',
  'inference.requested',
  'inference.completed',
  'inference.failed',
  'model.call.completed',
  'human.review.requested',
  'human.review.approved',
  'human.review.rejected',
  'human.review.resolved',
]);

const presentConversationMessage = (message: {
  messageId: string;
  role: string;
  messageKind: string;
  content: string;
  sequenceNumber: number;
  createdAt: string;
}): ThetaWebConversationMessage => ({
  messageId: message.messageId,
  role: message.role as 'user' | 'assistant',
  messageKind: message.messageKind,
  content: message.content,
  sequenceNumber: message.sequenceNumber,
  createdAt: message.createdAt,
});

const sanitizeEventPayload = (payload: unknown): unknown => {
  if (payload === undefined || payload === null) return undefined;
  try {
    const json = JSON.stringify(payload);
    if (json.length <= 12_000) return JSON.parse(json) as unknown;
    return {
      truncated: true,
      preview: json.slice(0, 12_000),
    };
  } catch {
    const text = String(payload);
    return text.length <= 12_000 ? text : `${text.slice(0, 12_000)}…`;
  }
};

const eventDetail = (payload: Record<string, unknown> | undefined): string | undefined => {
  const state = stringField(payload, 'stateId') ?? stringField(payload, 'toStateId');
  const toolId = stringField(payload, 'toolId');
  if (state) return `状态：${humanState(state)}`;
  if (toolId) return `工具：${toolId}`;
  return undefined;
};

const normalizeRunEvents = (evidence: {
  orchestrationEvents: Array<{ id: string; type: string; timestamp: string; payload: unknown }>;
  toolEvents: Array<{ id: string; type: string; timestamp: string; payload: unknown }>;
}): ThetaWebRunEvent[] => [
  ...evidence.orchestrationEvents.map((event) => ({
    id: event.id,
    source: 'orchestration' as const,
    type: event.type,
    title: EVENT_TITLES[event.type] ?? event.type,
    ...(eventDetail(asRecord(event.payload)) ? { detail: eventDetail(asRecord(event.payload)) } : {}),
    timestamp: event.timestamp,
    ...(event.payload !== undefined ? { payload: sanitizeEventPayload(event.payload) } : {}),
  })),
  ...evidence.toolEvents.map((event) => ({
    id: event.id,
    source: 'tool' as const,
    type: event.type,
    title: EVENT_TITLES[event.type] ?? event.type,
    ...(eventDetail(asRecord(event.payload)) ? { detail: eventDetail(asRecord(event.payload)) } : {}),
    timestamp: event.timestamp,
    ...(event.payload !== undefined ? { payload: sanitizeEventPayload(event.payload) } : {}),
  })),
].sort((left, right) => left.timestamp.localeCompare(right.timestamp));

const buildReasoning = async (
  runId: string,
  runtimeDb: string,
  workflow: ThetaWorkflowService,
): Promise<ThetaWebReasoning> => {
  const [context, plan, evidence] = await Promise.all([
    workflow.conversationContext(runId, runtimeDb),
    workflow.plan(runId, runtimeDb).catch(() => undefined),
    workflow.evidence(runId, runtimeDb),
  ]);

  const store = new SQLiteConversationStore(runtimeDb);
  let decisionGaps: ThetaWebReasoning['decisionGaps'] = [];
  try {
    const messages = store
      .listRecentMessages(`theta-web-${runId}`, 400)
      .filter((message) => message.runId === runId)
      .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
    let current: ThetaWebReasoning['decisionGaps'][number] | undefined;
    for (const message of messages) {
      if (message.messageKind === 'research.decision-gap') {
        current = { question: message.content, answers: [], resolved: false };
        decisionGaps.push(current);
      } else if (message.messageKind === 'research.decision-answer' && current) {
        current.answers.push({ content: message.content, createdAt: message.createdAt });
      }
    }
    const openQuestion = context.decisionGap?.question;
    decisionGaps = decisionGaps.map((gap) => ({
      ...gap,
      resolved: gap.question !== openQuestion && gap.answers.length > 0,
    }));
  } finally {
    store.close();
  }

  const toolPhases: Record<string, ThetaWebReasoningToolCall['phase']> = {
    'tool.call.requested': 'requested',
    'tool.call.started': 'started',
    'tool.policy.checked': 'policy',
    'tool.call.completed': 'completed',
    'tool.call.failed': 'failed',
    'tool.output.validated': 'validated',
  };
  const toolCalls: ThetaWebReasoningToolCall[] = evidence.toolEvents
    .filter((event) => Object.prototype.hasOwnProperty.call(toolPhases, event.type))
    .map((event) => {
      const record = asRecord(event.payload);
      const toolId = stringField(record, 'toolId') ?? 'unknown-tool';
      const invocationId = stringField(record, 'invocationId');
      return {
        eventId: event.id,
        ...(invocationId ? { invocationId } : {}),
        toolId,
        phase: toolPhases[event.type],
        label: EVENT_TITLES[event.type] ?? event.type,
        timestamp: event.timestamp,
        payload: sanitizeEventPayload(event.payload),
      };
    });

  const recommendationEvent = evidence.toolEvents
    .filter((event) => event.type === 'tool.call.completed')
    .map((event) => asRecord(event.payload))
    .find((payload) => stringField(payload, 'toolId') === 'theta.model.recommend');

  return {
    runId,
    ...(context.researchIntent
      ? { researchIntent: context.researchIntent as Record<string, unknown> }
      : context.researchBrief
        ? { researchIntent: context.researchBrief as unknown as Record<string, unknown> }
        : {}),
    ...(context.researchIntentSummary
      ? { intentSummary: context.researchIntentSummary as unknown as Record<string, unknown> }
      : {}),
    ...(context.decisionGap ? { currentDecisionGap: context.decisionGap.question } : {}),
    decisionGaps,
    ...(recommendationEvent ? { recommendation: sanitizeEventPayload(recommendationEvent) as Record<string, unknown> } : {}),
    ...(plan
      ? {
          plan: {
            state: context.status.currentState ?? 'unknown',
            presentation: buildHumanResponse(plan) as NonNullable<ThetaWebReasoning['plan']>['presentation'],
          },
        }
      : {}),
    toolCalls,
    reasoningEvents: normalizeRunEvents(evidence).filter((event) =>
      REASONING_EVENT_TYPES.has(event.type)),
  };
};

const runStream = (
  response: ServerResponse,
  runId: string,
  options: Required<ThetaWebApiOptions>,
  workflow: ThetaWorkflowService,
): void => {
  writeCors(response);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let sequence = 0;
  let lastEventId: string | undefined;
  let lastMessageSeq = -1;
  let lastStatusKey = '';
  let lastTrainingKey = '';
  const send = (kind: ThetaWebStreamEvent['kind'], data: unknown): void => {
    response.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const tick = async (): Promise<void> => {
    try {
      const evidence = await workflow.evidence(runId, options.runtimeDb);
      const events = normalizeRunEvents(evidence);
      if (lastEventId === undefined) {
        lastEventId = events.at(-1)?.id;
        const status = await workflow.status(runId, options.runtimeDb);
        lastStatusKey = `${status.status}|${status.currentState}|${status.lastEventAt}`;
        send('snapshot', {
          runId,
          status: presentRun(status),
          lastEventId,
        });
      } else {
        const index = events.findIndex((event) => event.id === lastEventId);
        const fresh = index >= 0 ? events.slice(index + 1) : events;
        if (fresh.length > 0) {
          lastEventId = fresh.at(-1)?.id;
          send('events', { events: fresh });
        }
      }
      const status = await workflow.status(runId, options.runtimeDb);
      const statusKey = `${status.status}|${status.currentState}|${status.lastEventAt}`;
      if (statusKey !== lastStatusKey) {
        lastStatusKey = statusKey;
        send('status', { status: presentRun(status) });
      }
      const store = new SQLiteConversationStore(options.runtimeDb);
      try {
        const messages = store
          .listRecentMessages(`theta-web-${runId}`, 100)
          .filter((message) => message.runId === runId);
        const fresh = messages.filter((message) => message.sequenceNumber > lastMessageSeq);
        if (fresh.length > 0) {
          lastMessageSeq = Math.max(...fresh.map((message) => message.sequenceNumber));
          send('messages', {
            messages: fresh
              .filter((message) => message.role === 'user' || message.role === 'assistant')
              .map(presentConversationMessage),
          });
        } else if (messages.length > 0) {
          lastMessageSeq = Math.max(...messages.map((message) => message.sequenceNumber));
        }
      } finally {
        store.close();
      }
      const trainingRunId = stringField(status.trainingReceipt, 'trainingRunId');
      if (trainingRunId) {
        const observed = await runThetaTrainingStatus({ trainingRunId, logLimit: 20 });
        const receipt = observed.output?.found ? observed.output.receipt : undefined;
        const key = JSON.stringify(receipt ?? observed.status);
        if (key !== lastTrainingKey) {
          lastTrainingKey = key;
          send('training', {
            trainingRunId,
            ...(receipt ? { receipt } : { status: observed.status }),
            logs: observed.output?.logs.filter((line) => line.trim()).slice(-8) ?? [],
          });
        }
      }
      response.write(': keep-alive\n\n');
    } catch (error) {
      send('heartbeat', {
        error: error instanceof Error ? error.message : String(error),
        sequence: ++sequence,
      });
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 1500);
  void tick();
  response.on('close', () => {
    clearInterval(timer);
  });
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
  return {
    id: event.id,
    source: event.type.startsWith('tool.') ? 'tool' : 'workflow',
    type: event.type,
    title: EVENT_TITLES[event.type] ?? event.type,
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
  const roots = [
    path.join(agentRoot, 'fixtures'),
    path.join(agentRoot, 'third_party', 'THETA', 'data'),
  ];
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
    if (!facts || !understanding) {
      store.refreshMemory(sessionId);
      return;
    }
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
    store.refreshMemory(sessionId);
  } finally {
    store.close();
  }
};

const promoteWorkspaceConversation = (
  runtimeDb: string,
  sourceSessionId: string,
  runId: string,
): void => {
  if (!sourceSessionId.startsWith('theta-web-workspace-')) {
    throw new SyntaxError('sourceSessionId is not a workspace conversation.');
  }
  const store = new SQLiteConversationStore(runtimeDb);
  try {
    if (!store.getSession(sourceSessionId)) return;
    const targetSessionId = `theta-web-${runId}`;
    store.getOrCreateSession(targetSessionId, { activeRunId: runId });
    for (const message of store.listRecentMessages(sourceSessionId, 100)) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      store.appendMessage({
        messageId: `message.${message.role}.${randomUUID()}`,
        sessionId: targetSessionId,
        runId,
        role: message.role,
        messageKind: message.messageKind,
        content: message.content,
        createdAt: message.createdAt,
      });
    }
    store.refreshMemory(targetSessionId);
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
  const uploadRoot = path.resolve(
    agentRoot,
    'third_party',
    'THETA',
    'data',
    '.theta_uploads',
  );
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
  const allowedRoot = path.resolve(
    agentRoot,
    'third_party',
    'THETA',
    'result',
  );
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

const languageProviderEnabled = (input: {
  useLanguageProvider?: boolean;
  /** @deprecated Kept for API compatibility with provider-specific clients. */
  useMiniMax?: boolean;
}): boolean => input.useLanguageProvider ?? input.useMiniMax ?? true;

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
