import {
  ThetaWorkflowService,
  type ThetaWorkflowRunResult,
  type ThetaWorkflowStatus,
} from '../theta-workflow-service.js';
import { runThetaTrainingStatus } from '@theta-agent/tools/hypha-runner.js';

export interface TrainingFollowOptions {
  runId: string;
  runtimeDb: string;
  intervalMs?: number;
  maxPolls?: number;
  onUpdate?: (
    value: ThetaWorkflowStatus | ThetaWorkflowRunResult,
  ) => void | Promise<void>;
  onHeartbeat?: (
    elapsedMs: number,
    polls: number,
    value: ThetaWorkflowStatus | ThetaWorkflowRunResult,
  ) => void | Promise<void>;
  heartbeatMs?: number;
  shouldStop?: () => boolean;
}

export interface TrainingFollowResult {
  final: ThetaWorkflowStatus | ThetaWorkflowRunResult;
  polls: number;
  detached: boolean;
}

const terminalStates = new Set([
  'Completed',
  'Failed',
  'Cancelled',
  'Quarantined',
]);

export class TrainingFollowController {
  constructor(private readonly workflow = new ThetaWorkflowService()) {}

  async follow(options: TrainingFollowOptions): Promise<TrainingFollowResult> {
    const intervalMs = Math.max(250, options.intervalMs ?? 1_500);
    const maxPolls = Math.max(1, options.maxPolls ?? 2_400);
    const heartbeatMs = Math.max(5_000, options.heartbeatMs ?? 15_000);
    const startedAt = Date.now();
    let nextHeartbeatAt = startedAt + heartbeatMs;
    let current: ThetaWorkflowStatus | ThetaWorkflowRunResult =
      await this.workflow.status(options.runId, options.runtimeDb);
    current = await retryAwareStatus(current);
    await options.onUpdate?.(current);
    for (let polls = 0; polls < maxPolls; polls += 1) {
      if (isTerminal(current)) {
        return { final: current, polls, detached: false };
      }
      if (options.shouldStop?.()) {
        return { final: current, polls, detached: true };
      }
      await delay(intervalMs);
      current = await this.workflow.resume({
        runId: options.runId,
        runtimeDb: options.runtimeDb,
      });
      current = await retryAwareStatus(current);
      await options.onUpdate?.(current);
      if (Date.now() >= nextHeartbeatAt) {
        await options.onHeartbeat?.(Date.now() - startedAt, polls + 1, current);
        nextHeartbeatAt = Date.now() + heartbeatMs;
      }
    }
    return { final: current, polls: maxPolls, detached: true };
  }
}

const isTerminal = (
  value: ThetaWorkflowStatus | ThetaWorkflowRunResult,
): boolean =>
  terminalStates.has(value.currentState ?? '') ||
  ['completed', 'failed', 'cancelled'].includes(String(value.status));

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryAwareStatus = async (
  value: ThetaWorkflowStatus | ThetaWorkflowRunResult,
): Promise<ThetaWorkflowStatus | ThetaWorkflowRunResult> => {
  const source = asRecord(value.trainingReceipt);
  const sourceRunId =
    typeof source?.trainingRunId === 'string'
      ? source.trainingRunId
      : undefined;
  if (!sourceRunId) return value;
  try {
    const result = await runThetaTrainingStatus({
      trainingRunId: sourceRunId,
      logLimit: 1,
    });
    if (
      result.status !== 'completed' ||
      !result.output ||
      result.output.found === false
    ) {
      return value;
    }
    const receipt = asRecord(result.output.receipt);
    if (!receipt) return value;
    const retryStatus = String(receipt.status);
    return {
      ...value,
      status:
        retryStatus === 'completed'
          ? 'completed'
          : retryStatus === 'failed' || retryStatus === 'cancelled'
            ? 'failed'
            : 'waiting_timer',
      currentState:
        retryStatus === 'completed'
          ? 'Completed'
          : retryStatus === 'failed'
            ? 'Failed'
            : 'MonitorTraining',
      trainingReceipt: receipt,
    } as ThetaWorkflowStatus | ThetaWorkflowRunResult;
  } catch {
    return value;
  }
};

const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
