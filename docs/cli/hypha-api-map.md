# Hypha API Map

Hypha is consumed as the published npm release line `@codesoul-co/hypha-*`
(one version for every package; the installed release is reported by
`npm run doctor`). Upstream repository: `CodeSoul-co/Hypha`.

This map records the current APIs that THETA CLI Agent must use. Do not assume names from planning
documents when they differ from the installed release.

## Packages Used By The CLI Agent

Runtime imports currently require:

- `@codesoul-co/hypha-adapters-local`
- `@codesoul-co/hypha-core`
- `@codesoul-co/hypha-domain`
- `@codesoul-co/hypha-fsm`
- `@codesoul-co/hypha-harness`
- `@codesoul-co/hypha-inference`
- `@codesoul-co/hypha-kernel`
- `@codesoul-co/hypha-mcp`
- `@codesoul-co/hypha-memory`
- `@codesoul-co/hypha-skills`
- `@codesoul-co/hypha-storage`
- `@codesoul-co/hypha-tools`
- runtime dependencies: `zod`, `ajv`, `ajv-formats`

Each package is installed from the npm registry on one release version; the
published release line is the authority. `config/upstreams.lock.json` pins only
the THETA checkout.

## Core

Source: `Hypha/packages/core/src`.

Important exports:

- `JsonSchema`: shared JSON Schema type from `specs.ts`.
- `PolicyDecision`: `{ allowed, requiresHumanReview?, policyId?, ruleId?, reason?, metadata? }`.
- `PolicyEvaluationContext`: includes `runId`, `stepId`, `userId`, `capabilityId`,
  `sideEffectLevel`, `input`, and `metadata`.
- `PolicyEngine`: `evaluate(context): Promise<PolicyDecision>`.
- `allowAllPolicyEngine`, `denyExternalEffectsPolicyEngine`, `createPolicySpecEngine`.
- `TraceRecorder`: `record(event: FrameworkEvent): Promise<void>`.
- `EventStore`: `append(event)`, `list(filter?)`.
- `InMemoryEventStore`: implements both `EventStore` and `TraceRecorder`.
- `createFrameworkEvent(input)`: canonical Framework event constructor.

THETA usage:

- Use `InMemoryEventStore` only for isolated tool smoke tests.
- Use the SQLite-backed EventRuntime for canonical workflows. TrainingPlan,
  human-review, dry-run, and TrainingRun authority must be represented by
  TypeScript contracts and Hypha events; Python is an execution adapter.
- Use `PolicyEngine` directly. Do not create a parallel local policy abstraction.

## Tools

Source: `Hypha/packages/tools/src/index.ts`.

### ToolSpec

Required fields:

- `id`
- `version`
- `description`
- `inputSchema`
- `sideEffectLevel`

Common optional fields:

- `revision`
- `displayName`
- `outputSchema`
- `permissionScope`
- `timeoutPolicy`
- `retryPolicy`
- `auditPolicy`
- `humanApprovalPolicy`
- `idempotencyPolicy`
- `metadata`

### ToolRegistry

Constructor: `new ToolRegistry()`.

Methods:

- `register(spec, handler, options?)`
- `registerAdapter(spec, adapter, options?)`
- `unregister(toolId)`
- `getSpec(toolId)`
- `getAdapter(toolId)`
- `getTargetResolver(toolId)`
- `resolve({ id, version?, revision? })`
- `list()`

Registration options:

- `replace?: boolean`
- `targetResolver?: ToolTargetResolver`

### ToolAdapter

Interface:

- `id`
- `source`
- `capabilities()`
- `execute(request)`
- optional `cancel(request)`
- `health()`
- optional `close()`

Built-in local adapter:

- `LocalFunctionToolAdapter(id, handler)`

THETA tools integration is reachable only from registered Tool handlers.
CLI and WorkflowExecutor code must not call THETA tools directly.

### GovernedToolRunner

Constructor:

```ts
new GovernedToolRunner(
  registry,
  trace,
  policy = denyExternalEffectsPolicyEngine,
  options?
)
```

Options include:

- `approvalStore`
- `invocationStore`
- `authorizer`
- `middleware`
- `artifactPort`
- `snapshotStore`
- `receiptReconciler`
- `resultCache`
- `resultCacheFailureMode`
- `resultCacheTimeoutMs`
- `resultCacheMaxEntryBytes`
- `resultCacheArtifactVerifier`
- `observationPort`
- `telemetry`
- `now`

ToolRunner API:

- `run(request): Promise<ToolCallResult>`
- optional `cancelInvocation(invocationId, reason?)`

Default stores:

- `InMemoryToolApprovalStore`
- `InMemoryToolInvocationStore`

Default authorizer:

- `PermissionScopeToolAuthorizer`

Important implication:

- permission checks should be represented on `ToolSpec.permissionScope` or
  `ToolSpec.governance.requiredPermissionScopes`;
- side-effect policy flows through `PolicyEngine`;
- idempotency flows through `ToolInvocationStore`.

## FSM

Source: `Hypha/packages/fsm/src/index.ts`.

Important exports:

- `FSMProcessSpec`
- `FSMStateSpec`
- `FSMTransitionSpec`
- `FSMSnapshot`
- `FSMRuntimeOptions`
- `FSMGuardEvaluator`
- `validateFSMProcessSpec(spec)`
- `getAllowedTransitions(spec, stateId)`
- `createInitialSnapshot(spec, runId, now?)`
- `defaultReActFSMProcessSpec`

First THETA DomainPack should compile to `FSMProcessSpec`. Runtime code should persist and recover
`FSMSnapshot`; it should not infer state from CLI state.

## Domain

Source: `Hypha/packages/domain/src/index.ts`.

Important exports:

- `DomainPackSpec`
- `WorkflowSpec`
- `WorkflowStateSpec`
- `WorkflowTransitionSpec`
- `SessionProfileSpec`
- `DomainPackRegistry`
- `LocalDomainPackLoader`
- `DomainCompiler`
- `WorkflowCompiler`
- `initializeDomainSession(domainPack, options?)`
- `compileWorkflowToFSM(domainPack, options?)`
- `compileDomainPackToHarnessedSystem(input, options)`
- `validateDomainPackSpec(input)`

Workflow state bindings expose:

- `stateId`
- `allowedTools`
- `allowedSkills`
- `requiredSkills`
- optional tool profile refs and policy refs through compilation.

The current `domain.theta.training@3.0.0` workflow includes:

- deterministic intake and research clarification;
- dataset inspection and explicit column confirmation;
- evidence-backed model recommendation and plan validation;
- separate plan-creation and training-start approvals;
- deterministic dry-run and pre-start dataset verification;
- training start, durable monitoring, completion, cancellation, failure, and
  quarantine outcomes.

## Current Architecture Guardrails

- CLI must not call `callThetaTools` directly after the governed adapter exists.
- WorkflowExecutor must not spawn Python.
- Python THETA tools must not decide FSM state, policy, approval, or recommendation authority.
- Formal contracts should import `JsonSchema` from `@codesoul-co/hypha-core`.
- Python interpreter discovery, module probing, THETA tools calls, and local process
  execution remain inside `tools/theta-tools.ts`; diagnostic callers receive
  structured results rather than owning process execution.
