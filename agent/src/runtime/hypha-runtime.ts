import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SQLiteDurableEventStore,
  SQLiteProjectionStore,
  SQLiteRunLeaseStore,
  SQLiteStateExecutionClaimStore,
} from '@codesoul-co/hypha-adapters-local';
import {
  DurableEventRuntime,
  DurableRuntimeTimerWorker,
  InMemoryEventSchemaRegistry,
  ProjectionEngine,
  RuntimeHumanWaitService,
  registerRuntimeOrchestrationEventSchemas,
  type EventFilter,
  type EventRuntime,
  type FrameworkEvent,
  type ProjectionEngine as ProjectionEnginePort,
  type ProjectionStore,
  type RunLeaseStore,
  type RuntimeOrchestrationProjection,
  type StateExecutionClaimStore,
  type TraceRecorder,
} from '@codesoul-co/hypha-core';
import {
  FencedBoundedFSMDriver,
  type FencedBoundedFSMDriverOptions,
} from '@codesoul-co/hypha-harness';
import { repositoryRoot } from '@theta-agent/tools/support/repository-paths.js';

export interface ThetaWorkflowRuntimeOptions {
  filename?: string;
  now?: () => string;
  nextId?: (namespace: string) => string;
}

export interface ThetaWorkflowRuntime {
  filename: string;
  events: EventRuntime;
  projections: ProjectionEnginePort;
  projectionStore: ProjectionStore<RuntimeOrchestrationProjection>;
  runLeases: RunLeaseStore;
  stateClaims: StateExecutionClaimStore;
  humanWaits: RuntimeHumanWaitService;
  timers: DurableRuntimeTimerWorker;
  createDriver(
    executeState: FencedBoundedFSMDriverOptions['executeState'],
  ): FencedBoundedFSMDriver;
  close(): void;
}

export const defaultThetaWorkflowDb = (): string =>
  path.resolve(
    process.env.THETA_WORKFLOW_DB ??
      path.join(repositoryRoot, '.theta_agent', 'theta-workflow.sqlite'),
  );

export const createThetaWorkflowRuntime = async (
  options: ThetaWorkflowRuntimeOptions = {},
): Promise<ThetaWorkflowRuntime> => {
  const filename = path.resolve(options.filename ?? defaultThetaWorkflowDb());
  const nextId =
    options.nextId ?? ((namespace: string) => `${namespace}.${randomUUID()}`);
  const schemas = new InMemoryEventSchemaRegistry();
  await registerRuntimeOrchestrationEventSchemas(schemas);

  const closeables: Array<{ close(): void }> = [];
  const eventStore = opened(
    new SQLiteDurableEventStore({
      filename,
      schemaRegistry: schemas,
      now: options.now,
    }),
    closeables,
  );
  const events = new DurableEventRuntime({
    store: eventStore,
    now: options.now,
  });
  const projectionStore = opened(
    new SQLiteProjectionStore<RuntimeOrchestrationProjection>({
      filename,
      now: options.now,
    }),
    closeables,
  );
  const projections = new ProjectionEngine({ events, now: options.now });
  const runLeases = opened(
    new SQLiteRunLeaseStore({ filename, now: options.now }),
    closeables,
  );
  const stateClaims = opened(
    new SQLiteStateExecutionClaimStore({
      filename,
      runLeaseStore: runLeases,
      now: options.now,
    }),
    closeables,
  );
  const humanWaits = new RuntimeHumanWaitService({
    events,
    projections,
    projectionStore,
    runLeases,
    now: options.now,
    nextId,
  });
  const timers = new DurableRuntimeTimerWorker({
    events,
    projections,
    projectionStore,
    runLeases,
    now: options.now,
    nextId,
  });
  let closed = false;

  return {
    filename,
    events,
    projections,
    projectionStore,
    runLeases,
    stateClaims,
    humanWaits,
    timers,
    createDriver: (executeState) =>
      new FencedBoundedFSMDriver({
        events,
        projections,
        projectionStore,
        runLeases,
        stateClaims,
        executeState,
        now: options.now,
        nextId,
      }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const closeable of [...closeables].reverse()) {
        closeable.close();
      }
    },
  };
};

const opened = <T extends { close(): void }>(
  value: T,
  closeables: Array<{ close(): void }>,
): T => {
  closeables.push(value);
  return value;
};

export class JsonlToolTraceRecorder implements TraceRecorder {
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly filename: string) {}

  record(event: FrameworkEvent): Promise<void> {
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true });
      await appendFile(this.filename, `${JSON.stringify(event)}\n`, 'utf8');
    });
    return this.writes;
  }

  async list(filter: EventFilter = {}): Promise<FrameworkEvent[]> {
    await this.writes;
    let raw: string;
    try {
      raw = await readFile(this.filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FrameworkEvent)
      .filter((event) => matchesFilter(event, filter));
  }
}

export const thetaToolTraceFile = (
  runtimeDb: string,
  runId: string,
): string => {
  const digest = createHash('sha256').update(runId).digest('hex');
  return path.join(
    path.dirname(path.resolve(runtimeDb)),
    'tool-traces',
    `${digest}.jsonl`,
  );
};

const matchesFilter = (event: FrameworkEvent, filter: EventFilter): boolean => {
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId)
    return false;
  if (filter.type !== undefined && event.type !== filter.type) return false;
  return true;
};
