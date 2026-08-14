import { createHash } from 'node:crypto';
import type { ToolCallResult } from '@codesoul-co/hypha-tools';
import type { AgentInvocation } from './conversation/contracts.js';
import type { LanguageRequest, LanguageResult } from '@theta-agent/domain/language/contracts.js';
import { deterministicLanguageResult } from '@theta-agent/tools/support/language/fallback.js';
import { sanitizeLanguageRequest } from '@theta-agent/tools/support/language/sanitizer.js';
import { isInferenceProviderConfigured } from '@theta-agent/tools/support/providers/registry.js';
import { THETA_APPROVAL_KEYS } from '@theta-agent/domain/domain.js';
import { ThetaWorkflowService } from './theta-workflow-service.js';
import { ModelSelectionService } from './inference/model-selection-service.js';
import {
  requestThetaTrainingCancel,
  requestThetaLanguageGenerate,
  runApprovedThetaTrainingCancel,
  runApprovedThetaLanguageGenerate,
  runThetaRagBuild,
  runThetaRagStatus,
  runThetaTrainingStatus,
} from '@theta-agent/tools/hypha-runner.js';

export type OperatorInvocation = Exclude<
  AgentInvocation,
  | { kind: 'doctor' }
  | { kind: 'workflow' }
  | { kind: 'status' }
  | { kind: 'audit' }
  | { kind: 'repl' }
>;

export interface OperatorCommandExecutor {
  execute(invocation: OperatorInvocation): Promise<unknown>;
}

export interface OperatorCommandDependencies {
  workflow?: Pick<
    ThetaWorkflowService,
    'plan' | 'status' | 'resume' | 'evidence'
  >;
  trainingStatus?: typeof runThetaTrainingStatus;
  requestTrainingCancel?: typeof requestThetaTrainingCancel;
  approveTrainingCancel?: typeof runApprovedThetaTrainingCancel;
  ragBuild?: typeof runThetaRagBuild;
  ragStatus?: typeof runThetaRagStatus;
  requestLanguageGenerate?: typeof requestThetaLanguageGenerate;
  approveLanguageGenerate?: typeof runApprovedThetaLanguageGenerate;
  languageProviderConfigured?: () => boolean;
  deterministicLanguage?: (
    request: LanguageRequest,
  ) => LanguageResult;
}

export class ThetaOperatorCommandService implements OperatorCommandExecutor {
  private readonly workflow: Pick<
    ThetaWorkflowService,
    'plan' | 'status' | 'resume' | 'evidence'
  >;

  constructor(private readonly dependencies: OperatorCommandDependencies = {}) {
    this.workflow = dependencies.workflow ?? new ThetaWorkflowService();
  }

  async execute(invocation: OperatorInvocation): Promise<unknown> {
    if (invocation.kind === 'model') {
      return new ModelSelectionService().execute(
        invocation.action === 'use'
          ? {
              action: 'use',
              providerId: invocation.providerId!,
              model: invocation.model!,
            }
          : { action: invocation.action },
      );
    }
    if (invocation.kind === 'planShow') {
      return this.workflow.plan(invocation.runId, invocation.runtimeDb);
    }
    if (invocation.kind === 'planApprove') {
      const status = await this.workflow.status(
        invocation.runId,
        invocation.runtimeDb,
      );
      if (status.pendingActionRef !== THETA_APPROVAL_KEYS.planReview) {
        throw new Error(
          `Run ${invocation.runId} is not waiting at ${THETA_APPROVAL_KEYS.planReview}.`,
        );
      }
      return this.workflow.resume({
        runId: invocation.runId,
        ...(invocation.runtimeDb
          ? { runtimeDb: invocation.runtimeDb }
          : {}),
        approve: true,
        approvedBy: invocation.approvedBy ?? 'local_user',
      });
    }
    if (invocation.kind === 'evidenceShow') {
      return this.workflow.evidence(invocation.runId, invocation.runtimeDb);
    }
    if (invocation.kind === 'trainingStatus') {
      return requireCompleted(
        await (this.dependencies.trainingStatus ?? runThetaTrainingStatus)({
          trainingRunId: invocation.trainingRunId,
          ...(invocation.logLimit === undefined
            ? {}
            : { logLimit: invocation.logLimit }),
        }),
        'Training status',
      );
    }
    if (invocation.kind === 'trainingCancel') {
      const input = {
        trainingRunId: invocation.trainingRunId,
        reason: invocation.reason,
      };
      const key = `theta-agent-training-cancel-${createHash('sha256')
        .update(JSON.stringify(input))
        .digest('hex')
        .slice(0, 20)}`;
      const options = {
        invocationId: key,
        idempotencyKey: key,
      };
      if (!invocation.approve) {
        const result = await (
          this.dependencies.requestTrainingCancel ??
          requestThetaTrainingCancel
        )(input, options);
        return {
          status: result.status,
          toolId: result.toolId,
          approvalRequired: result.status === 'human_review_required',
          cancellationRecorded: false,
          message:
            'Review the cancellation reason, then repeat with --approve.',
        };
      }
      return requireCompleted(
        await (
          this.dependencies.approveTrainingCancel ??
          runApprovedThetaTrainingCancel
        )(input, options),
        'Approved training cancellation',
      );
    }
    if (invocation.kind === 'ragBuild') {
      return requireCompleted(
        await (this.dependencies.ragBuild ?? runThetaRagBuild)(),
        'RAG index build',
      );
    }
    if (invocation.kind === 'languageGenerate') {
      const request = sanitizeLanguageRequest(invocation.request);
      const configured = (
        this.dependencies.languageProviderConfigured ?? isInferenceProviderConfigured
      )();
      if (!configured) {
        return (
          this.dependencies.deterministicLanguage ??
          deterministicLanguageResult
        )(request);
      }
      const key = `theta-agent-language-${createHash('sha256')
        .update(JSON.stringify(request))
        .digest('hex')
        .slice(0, 20)}`;
      const options = {
        invocationId: key,
        idempotencyKey: key,
      };
      if (!invocation.approve) {
        const result = await (
          this.dependencies.requestLanguageGenerate ??
          requestThetaLanguageGenerate
        )(request, options);
        return {
          status: result.status,
          toolId: result.toolId,
          approvalRequired: result.status === 'human_review_required',
          providerConfigured: true,
          message:
            'Review the sanitized external inference request, then repeat with --approve.',
        };
      }
      return requireCompleted(
        await (
          this.dependencies.approveLanguageGenerate ??
          runApprovedThetaLanguageGenerate
        )(request, options),
        'Approved language generation',
      );
    }
    return requireCompleted(
      await (this.dependencies.ragStatus ?? runThetaRagStatus)(),
      'RAG index status',
    );
  }
}

const requireCompleted = <T>(
  result: ToolCallResult<T>,
  operation: string,
): T => {
  if (result.status !== 'completed' || result.output === undefined) {
    throw new Error(
      `${operation} failed: ${JSON.stringify(result.error ?? result.status)}`,
    );
  }
  return result.output;
};
