import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';
import { ThetaWorkflowService } from '../theta-workflow-service.js';
import {
  requestThetaTrainingCancel,
  runApprovedThetaTrainingCancel,
  runApprovedThetaTrainingStart,
  runThetaTrainingStatus,
} from '../tools/hypha-runner.js';
import {
  approvalReceiptSchema,
  dryRunReceiptSchema,
  trainingPlanRecordSchema,
} from '../planning/contracts.js';
import { openLocalFolder } from '../tools/theta-tools.js';

export interface ResultArtifactView {
  kind: string;
  path: string;
  exists: boolean;
  description: string;
}

export interface ResultVisualizationView {
  id: string;
  label: string;
  relativePath: string;
  format: 'image' | 'interactive';
  scope: 'global' | 'topic';
  topicId?: string;
  sizeBytes: number;
}

export interface RunResultOverview {
  kind: 'run.results';
  runId: string;
  trainingRunId?: string;
  status: string;
  progress: number;
  executionStatus?: string;
  qualityStatus?: string;
  researchStatus?: 'passed' | 'needs_review' | 'not_evaluated';
  currentStep?: string;
  resultRoot?: string;
  artifacts: ResultArtifactView[];
  visualizations: ResultVisualizationView[];
  metrics: Record<string, unknown>;
  topics: Array<{
    id: string;
    name: string;
    strength?: number;
    keywords: string[];
  }>;
  capabilities: {
    hasTimestamps?: boolean;
    hasDimensions?: boolean;
    temporalRequested?: boolean;
    groupComparisonRequested?: boolean;
    temporalMode?: 'native' | 'posthoc' | 'none';
    groupMode?: 'native' | 'posthoc' | 'none';
  };
  experiments: Array<{
    root: string;
    model: string;
    createdAt: string;
    metrics: Record<string, unknown>;
    current: boolean;
  }>;
  goalAssessment: Array<{
    criterion: string;
    status: 'satisfied' | 'not_satisfied' | 'not_evaluated';
    evidence: string;
  }>;
  comparison: string[];
  parameterDecisions: Record<string, unknown>;
  warnings: string[];
  topicTable?: string;
  logPath?: string;
  message: string;
}

export class ResultService {
  constructor(private readonly workflow = new ThetaWorkflowService()) {}

  async overview(runId: string, runtimeDb: string): Promise<RunResultOverview> {
    const [status, plan] = await Promise.all([
      this.workflow.status(runId, runtimeDb),
      this.workflow.plan(runId, runtimeDb),
    ]);
    let receipt = asRecord(status.trainingReceipt);
    const originalTrainingRunId = string(receipt?.trainingRunId);
    if (originalTrainingRunId) {
      try {
        const latest = await runThetaTrainingStatus({
          trainingRunId: originalTrainingRunId,
          logLimit: 1,
        });
        if (
          latest.status === 'completed' &&
          latest.output &&
          latest.output.found !== false
        ) {
          receipt = asRecord(latest.output.receipt) ?? receipt;
        }
      } catch {
        // Preserve the canonical workflow receipt if the runtime probe fails.
      }
    }
    const trainingRunId = string(receipt?.trainingRunId);
    const resolvedLogPath = await resolveTrainingLogPath(
      trainingRunId,
      string(receipt?.logPath),
    );
    const artifacts = array(receipt?.resultArtifacts)
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        kind: string(item.kind) ?? 'artifact',
        path: string(item.path) ?? '',
        exists: item.exists === true,
        description: string(item.description) ?? '',
      }))
      .filter((item) => item.path);
    const resultRoot = newestExperimentRoot(
      artifacts
        .filter((item) => item.exists && item.kind === 'results')
        .map((item) => item.path),
    );
    const metricsFile = resultRoot
      ? findFiles(resultRoot, (name) => /^metrics.*\.json$/iu.test(name))[0]
      : undefined;
    const topicTable = resultRoot
      ? findFiles(resultRoot, (name) => name === '主题表.csv')[0]
      : undefined;
    const readme = resultRoot
      ? findFiles(resultRoot, (name) => name === 'README.md')[0]
      : undefined;
    const readmeText = readme ? safeRead(readme) : '';
    const metrics = metricsFile ? readJson(metricsFile) : {};
    const topics = topicTable ? readTopicTable(topicTable) : [];
    const modelId = planModelId(plan);
    const hasTimestamps = readmeText
      ? /Has timestamps:\s*Yes/iu.test(readmeText)
      : false;
    const hasDimensions = resultRoot
      ? findDirectories(
          resultRoot,
          (name) =>
            /dimension|group|metadata|covariate|维度|分组|协变量|平台/iu.test(
              name,
            ),
          5,
        ).length > 0 ||
        findFiles(
          resultRoot,
          (name) =>
            /dimension|group|metadata|covariate|维度|分组|协变量|平台/iu.test(
              name,
            ),
        ).length > 0
      : false;
    const experimentRoots = allExperimentRoots(
      artifacts
        .filter((item) => item.exists && item.kind.startsWith('results'))
        .map((item) => item.path),
    );
    const experiments = experimentRoots.map((root) => {
      const experimentMetricsFile = findFiles(
        root,
        (name) => /^metrics.*\.json$/iu.test(name),
      )[0];
      return {
        root,
        model: path.basename(path.dirname(root)),
        createdAt: new Date(statSync(root).mtimeMs).toISOString(),
        metrics: experimentMetricsFile ? readJson(experimentMetricsFile) : {},
        current: root === resultRoot,
      };
    });
    const researchBrief = asRecord(plan.researchBrief) ?? {};
    const parameterDecisions =
      asRecord(asRecord(plan.plannerResolution)?.parameterDecisions) ??
      asRecord(asRecord(asRecord(plan.planRecord)?.review)?.parameterDecisions) ??
      {};
    const temporalRequested = researchBrief.trendAnalysis === true;
    const groupComparisonRequested =
      strings(researchBrief.comparisonGroups).length > 0;
    const figureCount = resultRoot
      ? findFiles(resultRoot, (name) => /\.(?:png|html)$/iu.test(name)).length
      : 0;
    const visualizations = resultRoot
      ? listVisualizations(resultRoot)
      : [];
    const visualizationWarnings = resultRoot
      ? findFiles(resultRoot, (name) => name === 'visualization_status.json')
          .flatMap((filename) => {
            const statusFile = readJson(filename);
            return array(statusFile.renderers)
              .map(asRecord)
              .filter(
                (item): item is Record<string, unknown> =>
                  Boolean(item) && item?.status === 'failed',
              )
              .map(
                (item) =>
                  `${string(item.language) ?? 'unknown'} 可视化进程失败（退出码 ${String(item.exit_code ?? 'unknown')}），其余训练与评估产物已保留。`,
              );
          })
      : [];
    const topicCollapse = detectTopicCollapse(topics, metrics);
    const goalAssessment = assessGoals({
      criteria: strings(researchBrief.successCriteria),
      trendAnalysis: researchBrief.trendAnalysis === true,
      comparisonGroups: strings(researchBrief.comparisonGroups),
      topics,
      metrics,
      hasTimestamps,
      hasDimensions,
      figureCount,
      hasLog: Boolean(resolvedLogPath),
    });
    const qualityStatus = string(asRecord(receipt?.quality)?.status);
    const researchStatus: RunResultOverview['researchStatus'] =
      qualityStatus === 'failed' || goalAssessment.length === 0
        ? 'not_evaluated'
        : goalAssessment.every((item) => item.status === 'satisfied')
          ? 'passed'
          : 'needs_review';
    return {
      kind: 'run.results',
      runId,
      ...(trainingRunId
        ? { trainingRunId }
        : {}),
      status: string(receipt?.status) ?? String(status.status),
      ...(string(receipt?.executionStatus)
        ? { executionStatus: string(receipt?.executionStatus) }
        : {}),
      ...(string(asRecord(receipt?.quality)?.status)
        ? { qualityStatus: string(asRecord(receipt?.quality)?.status) }
        : {}),
      researchStatus,
      progress: number(receipt?.progress) ?? (status.status === 'completed' ? 100 : 0),
      ...(string(receipt?.currentStep)
        ? { currentStep: string(receipt?.currentStep) }
        : {}),
      ...(resultRoot ? { resultRoot } : {}),
      artifacts,
      visualizations,
      metrics,
      topics,
      capabilities: {
        hasTimestamps,
        hasDimensions,
        temporalRequested,
        groupComparisonRequested,
        temporalMode: hasTimestamps
          ? modelId === 'dtm'
            ? 'native'
            : 'posthoc'
          : 'none',
        groupMode: hasDimensions
          ? modelId === 'stm'
            ? 'native'
            : 'posthoc'
          : 'none',
      },
      experiments,
      goalAssessment,
      comparison: compareExperiments(experiments),
      parameterDecisions,
      warnings: [
        ...(string(asRecord(receipt?.quality)?.status) === 'failed'
          ? ['训练执行已完成，但质量门未通过；当前结果不得标记为研究可用。']
          : string(asRecord(receipt?.quality)?.status) === 'warning'
            ? ['训练执行已完成，但质量门存在警告；请先复核再用于研究结论。']
            : []),
        ...visualizationWarnings,
        ...(topicCollapse.collapsed
          ? [
              `检测到主题塌缩：${topics.length} 个主题只有 ${topicCollapse.uniqueSignatures} 组不同的关键词，不能把“生成了目标数量的主题”等同于分析成功。`,
            ]
          : []),
      ],
      ...(topicTable ? { topicTable } : {}),
      ...(resolvedLogPath ? { logPath: resolvedLogPath } : {}),
      message:
        string(receipt?.status) === 'completed' ||
        status.currentState === 'Completed'
          ? '训练和产物验证已经完成。'
          : '这里显示当前 Run 已经记录的训练产物。',
    };
  }

  async logs(
    runId: string,
    runtimeDb: string,
    limit = 80,
  ): Promise<Record<string, unknown>> {
    const status = await this.workflow.status(runId, runtimeDb);
    const receipt = asRecord(status.trainingReceipt);
    const trainingRunId = string(receipt?.trainingRunId);
    if (!trainingRunId) {
      throw new Error('当前任务还没有训练进程，因此没有可显示的训练日志。');
    }
    const result = await runThetaTrainingStatus({
      trainingRunId,
      logLimit: limit,
    });
    if (result.status !== 'completed' || !result.output) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? '无法读取训练日志。'),
      );
    }
    return {
      kind: 'training.logs',
      ...result.output,
      rawLogs: array(result.output.logs),
      logs: summarizeLogs(array(result.output.logs)),
    };
  }

  async open(runId: string, runtimeDb: string): Promise<RunResultOverview> {
    const overview = await this.overview(runId, runtimeDb);
    if (!overview.resultRoot || !existsSync(overview.resultRoot)) {
      throw new Error('当前任务还没有可打开的结果目录。');
    }
    openLocalFolder(overview.resultRoot);
    return {
      ...overview,
      kind: 'run.results',
      message: `已打开结果目录：${overview.resultRoot}`,
    };
  }

  async cancel(
    runId: string,
    runtimeDb: string,
    reason: string,
    confirm: boolean,
  ): Promise<Record<string, unknown>> {
    const status = await this.workflow.status(runId, runtimeDb);
    const receipt = asRecord(status.trainingReceipt);
    const trainingRunId = string(receipt?.trainingRunId);
    if (!trainingRunId) {
      throw new Error('当前任务没有可以取消的训练进程。');
    }
    const input = { trainingRunId, reason };
    const key = `theta-repl-cancel-${createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .slice(0, 20)}`;
    const options = { invocationId: key, idempotencyKey: key };
    if (!confirm) {
      const gate = await requestThetaTrainingCancel(input, options);
      return {
        kind: 'training.cancel.review',
        trainingRunId,
        reason,
        status: gate.status,
        response: `取消尚未执行。请确认后输入：/cancel ${reason} --confirm`,
      };
    }
    const result = await runApprovedThetaTrainingCancel(input, options);
    if (result.status !== 'completed' || !result.output) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? '训练取消失败。'),
      );
    }
    return {
      kind: 'training.cancelled',
      ...result.output,
      response: '训练取消请求已经通过 Hypha 审批并执行。',
    };
  }

  async retry(
    runId: string,
    runtimeDb: string,
    reason = '用户已修复问题并明确请求安全重试',
  ): Promise<Record<string, unknown>> {
    const [status, planContext] = await Promise.all([
      this.workflow.status(runId, runtimeDb),
      this.workflow.plan(runId, runtimeDb),
    ]);
    const current = asRecord(status.trainingReceipt);
    const priorTrainingRunId = string(current?.trainingRunId);
    if (!priorTrainingRunId) {
      const legacyPlanningStall =
        status.status === 'running' &&
        ['RecommendModel', 'ValidatePlan'].includes(status.currentState ?? '') &&
        Date.now() - Date.parse(status.lastEventAt) > 11 * 60_000;
      if (status.status !== 'failed' && !legacyPlanningStall) {
        throw new Error('当前任务既不是失败 Run，也没有可重试的训练记录。');
      }
      return this.retryFailedWorkflow(
        runId,
        runtimeDb,
        planContext as unknown as Record<string, unknown>,
        reason,
      );
    }
    const qualityFailed = string(asRecord(current?.quality)?.status) === 'failed';
    if (qualityFailed) {
      throw new Error('质量门失败不能原样重跑。请先使用 /adjust 修改模型或参数，再创建新的训练 Run。');
    }
    if (!['failed', 'quarantined'].includes(string(current?.status) ?? '')) {
      throw new Error('只有执行失败或隔离状态的训练记录可以使用 /retry。');
    }
    const plan = trainingPlanRecordSchema.parse(planContext.planRecord);
    const planReview = approvalReceiptSchema.parse(planContext.planReview);
    const dryRun = dryRunReceiptSchema.parse(planContext.dryRun);
    const trainingReview = approvalReceiptSchema.parse(
      planContext.trainingReview,
    );
    const nextAttempt = (number(current?.attempt) ?? 1) + 1;
    const idempotencyKey = `theta-retry-${createHash('sha256')
      .update(
        `${priorTrainingRunId}:${String(nextAttempt)}:${plan.planHash}:${reason}`,
      )
      .digest('hex')}`;
    const result = await runApprovedThetaTrainingStart(
      {
        plan,
        planReview,
        dryRun,
        trainingReview,
        idempotencyKey,
        retryOfTrainingRunId: priorTrainingRunId,
        retryReason: reason,
      },
      {
        invocationId: idempotencyKey,
        idempotencyKey,
        userId: 'local_user',
      },
    );
    if (result.status !== 'completed' || !result.output) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? '安全重试启动失败。'),
      );
    }
    return {
      kind: 'training.retry.started',
      runId,
      retryOfTrainingRunId: priorTrainingRunId,
      receipt: result.output,
      status: result.output.status,
      response: `已创建第 ${String(result.output.attempt)} 次训练尝试，并保留原 ResearchBrief、列绑定和审批链。`,
    };
  }

  async reassess(
    runId: string,
    runtimeDb: string,
  ): Promise<Record<string, unknown>> {
    const status = await this.workflow.status(runId, runtimeDb);
    const current = asRecord(status.trainingReceipt);
    const trainingRunId = string(current?.trainingRunId);
    if (!trainingRunId) throw new Error('当前任务没有可重新评估的训练产物。');
    if (string(current?.status) !== 'completed') {
      throw new Error('只有执行完成的训练才可以重新评估质量。');
    }
    const result = await runThetaTrainingStatus({
      trainingRunId,
      logLimit: 1,
      reassessQuality: true,
    });
    if (result.status !== 'completed' || !result.output || result.output.found === false) {
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? '重新评估训练质量失败。'),
      );
    }
    return {
      kind: 'training.quality.reassessed',
      runId,
      trainingRunId: result.output.trainingRunId,
      quality: result.output.receipt.quality,
      reassessed: result.output.reassessed === true,
      response: '已基于当前落盘产物重新执行质量门；没有重新训练，也没有覆盖原始质量收据。',
    };
  }

  private async retryFailedWorkflow(
    runId: string,
    runtimeDb: string,
    planContext: Record<string, unknown>,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const evidence = await this.workflow.evidence(runId, runtimeDb);
    const started = evidence.orchestrationEvents.find((event) => event.type === 'run.started');
    const originalInput = asRecord(asRecord(started?.payload)?.input);
    if (!originalInput || !string(originalInput.filePath)) {
      throw new Error('失败 Run 缺少可恢复的原始工作流输入。');
    }
    const researchBrief = asRecord(planContext.researchBrief);
    const columnConfirmation = asRecord(planContext.columnConfirmation);
    const datasetConfirmation = asRecord(planContext.datasetConfirmation);
    const researchIntent = asRecord(planContext.researchIntent);
    const research = researchBrief
      ? Object.fromEntries(
          Object.entries(researchBrief).filter(
            ([key]) => !['schemaVersion', 'unknownFields'].includes(key),
          ),
        )
      : undefined;
    let recovered = await this.workflow.run({
      runtimeDb,
      input: {
        ...(originalInput as Record<string, unknown>),
        filePath: string(originalInput.filePath) as string,
        ...(research ? { research } : {}),
        ...(researchIntent ? { recoveredResearchIntent: researchIntent } : {}),
        recoveryOfRunId: runId,
        recoveryReason: reason,
      },
    });
    if (
      recovered.currentState === 'AwaitDatasetUnderstandingConfirmation' &&
      datasetConfirmation
    ) {
      const context = await this.workflow.conversationContext(recovered.runId, runtimeDb);
      if (
        context.datasetFacts?.datasetHash === string(datasetConfirmation.datasetHash)
      ) {
        recovered = await this.workflow.resume({
          runId: recovered.runId,
          runtimeDb,
          datasetConfirmation: {
            status: 'corrected',
            domainLabel: string(datasetConfirmation.domainLabel) ?? '通用文本分析',
            analysisUnit: string(datasetConfirmation.analysisUnit) ?? '每行一条文本记录',
            textColumns: strings(datasetConfirmation.textColumns),
            timeColumns: strings(datasetConfirmation.timeColumns),
            idColumns: strings(datasetConfirmation.idColumns),
            metadataColumns: strings(datasetConfirmation.metadataColumns),
            groupColumns: strings(datasetConfirmation.groupColumns),
            covariateColumns: strings(datasetConfirmation.covariateColumns),
            evaluationColumns: strings(datasetConfirmation.evaluationColumns),
            ignoredColumns: strings(datasetConfirmation.ignoredColumns),
          },
          approvedBy: 'local_user',
        });
      }
    }
    if (
      recovered.currentState === 'ColumnConfirmation' &&
      columnConfirmation
    ) {
      recovered = await this.workflow.resume({
        runId: recovered.runId,
        runtimeDb,
        columnConfirmation: {
          textColumns: strings(columnConfirmation.textColumns),
          timeColumn: string(columnConfirmation.timeColumn) ?? null,
          idColumn: string(columnConfirmation.idColumn) ?? null,
          covariateColumns: strings(columnConfirmation.covariateColumns),
          metadataColumns: strings(columnConfirmation.metadataColumns),
          groupingColumns: strings(columnConfirmation.groupingColumns),
          evaluationLabelColumns: strings(columnConfirmation.evaluationLabelColumns),
        },
        approvedBy: 'local_user',
      });
    }
    return {
      kind: 'workflow.retry.started',
      runId: recovered.runId,
      retryOfRunId: runId,
      status: recovered.status,
      currentState: recovered.currentState,
      pendingActionRef: recovered.pendingActionRef,
      response: '已创建受治理的恢复 Run；原失败 Run 保持不可变。数据哈希一致时，新 Run 会复用已确认的数据角色与 ResearchIntent，并重新执行原生 Planner V2。',
      workflow: recovered,
    };
  }
}

const newestExperimentRoot = (roots: string[]): string | undefined => {
  return allExperimentRoots(roots)[0];
};

const resolveTrainingLogPath = async (
  trainingRunId: string | undefined,
  knownPath: string | undefined,
): Promise<string | undefined> => {
  if (knownPath) return knownPath;
  if (!trainingRunId) return;
  try {
    const result = await runThetaTrainingStatus({
      trainingRunId,
      logLimit: 1,
    });
    if (
      result.status !== 'completed' ||
      !result.output ||
      result.output.found === false
    ) {
      return;
    }
    return string(asRecord(result.output.receipt)?.logPath);
  } catch {
    return;
  }
};

const allExperimentRoots = (roots: string[]): string[] => {
  const candidates = new Map<string, number>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Runtime artifacts are already bound to an exact attempt directory
    // (`run_*__primary_*`). Older layouts used nested `exp_*` directories.
    // Treat the bound root itself as a first-class experiment in both cases.
    candidates.set(root, statSync(root).mtimeMs);
    for (const directory of findDirectories(
      root,
      (name) => name.startsWith('exp_'),
      5,
    )) {
      candidates.set(directory, statSync(directory).mtimeMs);
    }
  }
  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([root]) => root);
};

const findDirectories = (
  root: string,
  predicate: (name: string) => boolean,
  maxDepth: number,
): string[] => {
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const entry of safeEntries(directory)) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(directory, entry.name);
      if (predicate(entry.name)) found.push(fullPath);
      visit(fullPath, depth + 1);
    }
  };
  visit(root, 0);
  return found;
};

const findFiles = (
  root: string,
  predicate: (name: string) => boolean,
): string[] => {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of safeEntries(directory)) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (predicate(entry.name)) found.push(fullPath);
    }
  };
  if (existsSync(root)) visit(root);
  return found;
};

const listVisualizations = (root: string): ResultVisualizationView[] =>
  findFiles(root, (name) => /\.(?:png|html)$/iu.test(name))
    .map((filename) => {
      const relativePath = path.relative(root, filename).split(path.sep).join('/');
      const topicMatch = relativePath.match(/(?:^|\/)topic_(\d+)(?:\/|$)/iu);
      const extension = path.extname(filename).toLowerCase();
      return {
        id: relativePath,
        label: path.basename(filename, extension),
        relativePath,
        format: extension === '.html' ? 'interactive' as const : 'image' as const,
        scope: topicMatch ? 'topic' as const : 'global' as const,
        ...(topicMatch ? { topicId: topicMatch[1] } : {}),
        sizeBytes: statSync(filename).size,
      };
    })
    .sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === 'global' ? -1 : 1;
      const topicOrder = Number(left.topicId ?? 0) - Number(right.topicId ?? 0);
      return topicOrder || left.label.localeCompare(right.label, 'zh-CN');
    });

const safeEntries = (directory: string): Dirent[] => {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

const readJson = (filename: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(readFileSync(filename, 'utf8')) as unknown;
    return asRecord(value) ?? {};
  } catch {
    return {};
  }
};

const safeRead = (filename: string): string => {
  try {
    return readFileSync(filename, 'utf8');
  } catch {
    return '';
  }
};

const readTopicTable = (
  filename: string,
): RunResultOverview['topics'] => {
  const lines = safeRead(filename)
    .split(/\r?\n/u)
    .filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(parseCsvLine).map((values) => {
    const row = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? '']),
    );
    const strength = Number(row.strength);
    return {
      id: row.topic_id || 'unknown',
      name: boundedTopicName(
        row.topic_name,
        (row.keywords ?? '')
          .split(/[，,]/u)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
      ...(Number.isFinite(strength) ? { strength } : {}),
      keywords: (row.keywords ?? '')
        .split(/[，,]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    };
  });
};

const boundedTopicName = (name: string, keywords: string[]): string => {
  const normalized = name.trim();
  if (
    normalized &&
    !/^(?:topic|主题)[-_ ]?\d+$/iu.test(normalized) &&
    normalized !== '未命名主题'
  ) {
    return normalized;
  }
  return keywords.length > 0
    ? keywords.slice(0, 3).join('·')
    : normalized || '未命名主题';
};

const planModelId = (value: unknown): string => {
  const plan = asRecord(value) ?? {};
  const canonical = asRecord(asRecord(plan.planRecord)?.canonicalPlan);
  const model = asRecord(canonical?.model);
  const validated = asRecord(plan.validatedPlan);
  return (
    string(model?.modelId) ??
    string(validated?.modelId) ??
    string(asRecord(plan.candidatePlan)?.modelId) ??
    'unknown'
  ).toLowerCase();
};

const assessGoals = (input: {
  criteria: string[];
  trendAnalysis: boolean;
  comparisonGroups: string[];
  topics: RunResultOverview['topics'];
  metrics: Record<string, unknown>;
  hasTimestamps: boolean;
  hasDimensions: boolean;
  figureCount: number;
  hasLog: boolean;
}): RunResultOverview['goalAssessment'] => {
  const topicCollapse = detectTopicCollapse(input.topics, input.metrics);
  const criteria = [
    ...input.criteria,
    ...(input.trendAnalysis ? ['生成时间趋势分析'] : []),
    ...(input.comparisonGroups.length > 0 ? ['完成分组比较'] : []),
  ];
  return [...new Set(criteria)].map((criterion) => {
    const topicRange = criterion.match(
      /(\d+)\s*(?:到|至|[-–—~～])\s*(\d+).{0,20}(?:主题|topics?)/iu,
    );
    if (topicRange) {
      const minimum = Number(topicRange[1]);
      const maximum = Number(topicRange[2]);
      const actual = input.topics.length;
      const countSatisfied = actual >= minimum && actual <= maximum;
      const requiresInterpretability =
        /容易命名|可解释|区分|关键词|代表文档|interpretable/iu.test(criterion);
      const satisfied =
        countSatisfied && !(requiresInterpretability && topicCollapse.collapsed);
      return {
        criterion,
        status: satisfied ? 'satisfied' : 'not_satisfied',
        evidence: satisfied
          ? `主题表实际包含 ${actual} 个主题，位于要求的 ${minimum}–${maximum} 个范围内。`
          : countSatisfied && topicCollapse.collapsed
            ? `数量上包含 ${actual} 个主题，但只有 ${topicCollapse.uniqueSignatures} 组不同关键词，发生主题塌缩，不能判定为容易命名且彼此可区分。`
            : `主题表实际包含 ${actual} 个主题，不在要求的 ${minimum}–${maximum} 个范围内。`,
      };
    }
    const requestsArtifactBundle =
      /(?:主题表|topic\s*table)/iu.test(criterion) &&
      /(?:指标|metrics?)/iu.test(criterion) &&
      /(?:日志|logs?)/iu.test(criterion) &&
      /(?:图|可视|charts?|visual)/iu.test(criterion);
    if (requestsArtifactBundle) {
      const checks = {
        主题表: input.topics.length > 0,
        指标: Object.keys(input.metrics).length > 0,
        日志: input.hasLog,
        图表: input.figureCount > 0,
      };
      const missing = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      return {
        criterion,
        status: missing.length === 0 ? 'satisfied' : 'not_satisfied',
        evidence:
          missing.length === 0
            ? `主题表、指标、日志和 ${input.figureCount} 个图表/交互文件均已找到。`
            : `尚未找到：${missing.join('、')}。`,
      };
    }
    if (/时间|趋势|演化|temporal|trend/iu.test(criterion)) {
      return {
        criterion,
        status: input.hasTimestamps ? 'satisfied' : 'not_satisfied',
        evidence: input.hasTimestamps
          ? '结果中存在与文档主题分布对齐的时间产物。'
          : '结果中没有时间产物。',
      };
    }
    if (/分组|来源|平台|比较|group|source|metadata/iu.test(criterion)) {
      return {
        criterion,
        status: input.hasDimensions ? 'satisfied' : 'not_satisfied',
        evidence: input.hasDimensions
          ? '结果中存在分组维度图或元数据产物。'
          : '结果中没有分组维度产物。',
      };
    }
    if (/代表文档|representative\s+documents?/iu.test(criterion)) {
      return {
        criterion,
        status: 'not_evaluated',
        evidence: topicCollapse.collapsed
          ? `主题关键词发生塌缩；现有结果也没有可供自动核验的代表文档绑定，必须人工复核。`
          : '现有结果没有可供自动核验的代表文档绑定，必须人工复核。',
      };
    }
    if (/主题|关键词|解释|topic|keyword/iu.test(criterion)) {
      return {
        criterion,
        status:
          input.topics.length > 0 && !topicCollapse.collapsed
            ? 'satisfied'
            : 'not_satisfied',
        evidence:
          input.topics.length > 0 && topicCollapse.collapsed
            ? `主题表虽包含 ${input.topics.length} 个主题，但只有 ${topicCollapse.uniqueSignatures} 组不同关键词，无法支持该目标。`
            : input.topics.length > 0
            ? `主题表包含 ${input.topics.length} 个主题及其真实关键词。`
            : '没有找到可解析的主题表。',
      };
    }
    if (/图|可视|visual/iu.test(criterion)) {
      return {
        criterion,
        status: input.figureCount > 0 ? 'satisfied' : 'not_satisfied',
        evidence: `找到 ${input.figureCount} 个图表或交互式可视化文件。`,
      };
    }
    if (/指标|质量|metric|coherence/iu.test(criterion)) {
      return {
        criterion,
        status:
          Object.keys(input.metrics).length > 0
            ? 'satisfied'
            : 'not_satisfied',
        evidence:
          Object.keys(input.metrics).length > 0
            ? '结果包含真实评估指标。'
            : '没有找到评估指标。',
      };
    }
    return {
      criterion,
      status: 'not_evaluated',
      evidence: '该成功标准不能由现有机器产物自动判定，需要研究者复核。',
    };
  });
};

const detectTopicCollapse = (
  topics: RunResultOverview['topics'],
  metrics: Record<string, unknown>,
): { collapsed: boolean; uniqueSignatures: number } => {
  const signatures = new Set(
    topics.map((topic) =>
      topic.keywords
        .slice(0, 8)
        .map((keyword) => keyword.trim().toLowerCase())
        .join('|'),
    ),
  );
  const td = numericMetric(metrics, 'td');
  const irbo = numericMetric(metrics, 'irbo');
  const duplicateSignatures =
    topics.length > 1 && signatures.size / topics.length <= 0.3;
  const metricCollapse =
    topics.length > 1 &&
    td !== undefined &&
    td <= 0.2 &&
    irbo !== undefined &&
    irbo <= 0.1;
  return {
    collapsed: duplicateSignatures || metricCollapse,
    uniqueSignatures: signatures.size,
  };
};

const compareExperiments = (
  experiments: RunResultOverview['experiments'],
): string[] => {
  if (experiments.length < 2) return [];
  const metricKeys = ['npmi', 'c_v', 'td', 'irbo'];
  return metricKeys.flatMap((key) => {
    const scored = experiments
      .map((experiment) => ({
        experiment,
        value: numericMetric(experiment.metrics, key),
      }))
      .filter(
        (
          item,
        ): item is {
          experiment: RunResultOverview['experiments'][number];
          value: number;
        } => item.value !== undefined,
      )
      .sort((left, right) => right.value - left.value);
    const best = scored[0];
    return best
      ? [
          `${key.toUpperCase()} 最高的是 ${path.basename(best.experiment.root)}（${best.value.toFixed(4)}）。`,
        ]
      : [];
  });
};

const numericMetric = (
  metrics: Record<string, unknown>,
  key: string,
): number | undefined => {
  const direct = metrics[key];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  for (const value of Object.values(metrics)) {
    const nested = asRecord(value);
    if (nested && typeof nested[key] === 'number' && Number.isFinite(nested[key])) {
      return nested[key] as number;
    }
  }
  return undefined;
};

const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
};

const summarizeLogs = (values: unknown[]): string[] => {
  const lines = values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter(
      (item) =>
        /^(Dataset:|Topics:|Train:|Eval:|Viz:|\[runner\])/iu.test(item) ||
        /Total charts generated|Visualizations saved|No timestamps available|No dimension values available/iu.test(
          item,
        ),
    )
    .map((item) =>
      item
        .replace(/^Dataset:/iu, '数据集：')
        .replace(/^Topics:/iu, '主题数：')
        .replace(/^Train:\s*completed/iu, '训练：已完成')
        .replace(/^Eval:\s*completed/iu, '评估：已完成')
        .replace(/^Viz:\s*completed/iu, '可视化：已完成')
        .replace(
          /\[Skip\]\s*No timestamps available/iu,
          '未生成时间趋势图：训练产物中没有时间戳',
        )
        .replace(
          /\[Skip\]\s*No dimension values available/iu,
          '未生成分组图：训练产物中没有分组值',
        )
        .replace(/Done!\s*Total charts generated:\s*~/iu, '生成图表约 ')
        .replace(/\[OK\]\s*Visualizations saved to:/iu, '图表目录：')
        .replace(/\[runner\]\s*completed/iu, '训练运行器：已完成'),
    );
  return [...new Set(lines)].slice(-20);
};

const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
