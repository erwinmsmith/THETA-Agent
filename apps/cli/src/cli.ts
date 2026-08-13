#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  requestThetaPlanApprove,
  requestThetaPlanCreate,
  requestThetaTrainingCancel,
  requestThetaTrainingStart,
  runApprovedThetaPlanApprove,
  runApprovedThetaPlanCreate,
  runApprovedThetaTrainingCancel,
  runApprovedThetaTrainingStart,
  runThetaDatasetDetectColumns,
  runThetaDatasetExplore,
  runThetaDatasetInspect,
  runThetaModelCatalog,
  runThetaModelRecommend,
  runThetaPlanValidate,
  runThetaTrainingDryRun,
  runThetaTrainingStatus,
} from "@theta-agent/agent";
import type { ThetaDatasetFileInput } from "@theta-agent/agent";
import type { ThetaDatasetExploreInput } from "@theta-agent/agent";
import type { ThetaModelRecommendInput } from "@theta-agent/agent";
import type { ThetaPlanApproveInput } from "@theta-agent/agent";
import type { ThetaPlanCreateInput } from "@theta-agent/agent";
import type { ThetaPlanValidateInput } from "@theta-agent/agent";
import type { ThetaTrainingCancelInput } from "@theta-agent/agent";
import type { ThetaTrainingDryRunInput } from "@theta-agent/agent";
import type { ThetaTrainingStartInput } from "@theta-agent/agent";
import { runThetaWorkflowCliCommand } from "./theta-workflow-cli.js";
import {
  ThetaWorkflowService,
  type ThetaWorkflowConversationContext,
} from "@theta-agent/agent";
import { datasetConfirmationDraftSchema } from "@theta-agent/agent";
import {
  isThetaAgentCommand,
  runThetaAgentCliCommand,
} from "./agent-cli.js";
import { loadThetaProjectEnvironment } from "@theta-agent/agent";
import { renderUserError } from "./presentation/terminal-renderer.js";
import { SQLiteDatasetRegistry } from "@theta-agent/agent";

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

interface CliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

const consoleOutput: CliOutput = {
  write: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

const helpText = `THETA CLI Agent

Usage:
  theta <command> [options]
  theta.cmd <command> [options]   (Windows local checkout)
  npm run cli -- <command> [options]

Commands:
  doctor [--json]
      Check the local THETA, Hypha, Python, runtime, and artifact environment.

  start --file <dataset> [--run-id <id>] [--runtime-db <path>]
      Start the durable event-first Agent workflow.

  resume --run-id <id> [--approve | --reject] [--runtime-db <path>]
      Resume a durable Run without reconstructing state in the CLI.

  answer --run-id <id> --text <natural-language-answer> [--runtime-db <path>]
      Interpret a research answer, persist a Brief revision, and resume.

  columns --run-id <id> --text <natural-language-confirmation> [--runtime-db <path>]
      Confirm text, time, ID, and metadata columns in natural language.

  status --run-id <id> [--runtime-db <path>]
      Read the current Run projection from canonical events.

  audit export --run-id <id> [--runtime-db <path>] [--json]
      Export orchestration events and governed tool trace to the terminal.

  plan show --run-id <id> [--runtime-db <path>] [--json]
      Show the candidate or canonical plan derived from Runtime events.

  plan approve --run-id <id> [--approved-by <user>]
      Approve only a Run currently waiting at HumanPlanReview.

  train status --run-id <id> [--log-limit <number>] [--json]
      Read governed training progress, receipts, logs, and lifecycle events.

  train cancel --run-id <id> --reason <text> [--approve] [--json]
      Request cancellation; repeat with --approve after explicit review.

  evidence show --run-id <id> [--runtime-db <path>] [--json]
      Show canonical orchestration events and governed tool events.

  rag build [--json]
      Build the allowlisted local evidence index through Hypha governance.

  rag status [--json]
      Read evidence-index readiness and source/chunk counts.

  language intent --text <text> [--approve] [--json]
      Classify only bounded read-only intent; external use requires approval.

  language question --text <draft> --field <field> --reason <reason> [--approve]
      Improve question wording without changing workflow decisions.

  language explain --model-id <id> --score <0-100> --confidence <level>
      --reason-codes <csv> [--warnings <csv>] [--evidence <text>] [--approve]
      Explain an existing deterministic recommendation without changing it.

  model list [--json]
  model current [--json]
  model use --provider <id> --model <model> [--json]
  model reset [--json]
      Inspect or change the persisted inference provider and model selection.

  repl [--run-id <id>] [--runtime-db <path>]
      Open the persistent conversational REPL with bounded provider assistance.

  dataset inspect --file <path> [--sample-size <number>]
      Inspect an allowed local dataset through Hypha governance.

  dataset detect-columns --file <path> [--sample-size <number>]
      Detect text, time, and metadata column candidates.

  dataset register --file <path> [--runtime-db <path>]
      Register an allowed local file and return an opaque dataset reference.

  dataset explore --dataset-ref <ref> [--sample-size <number>] [--runtime-db <path>]
      Explore a registered dataset through the governed V2 read tool.

  dataset understanding --run-id <id> [--runtime-db <path>] [--json]
      Read the current data understanding from canonical Run events.

  dataset confirm --run-id <id> --file <confirmation.json> [--runtime-db <path>]
      Validate one data-understanding confirmation and resume the same FSM Run.

  models
      List models exposed by THETA through Hypha governance.

  recommend --profile <file> --columns <confirmation-file> [--goal <text>] [--max-topics <number>]
      Recommend models from a normalized profile and confirmed column roles.

  plan validate --file <file>
      Validate a training plan without writing local state.

  plan create --file <bundle> [--approve]
      Create a canonical plan from the validated plan and binding snapshots.

  plan approve --plan-id <id> --plan-hash <hash> --approved-by <user> [--approve]
      Approve a stored plan. The operation also requires explicit --approve.

  training dry-run --file <request>
      Validate a plan + HumanPlanReview request without starting training.

  training start --file <request> [--approve]
      Start only with a plan, two approvals, and a successful dry-run receipt.

  training status --run-id <id> [--log-limit <number>]
      Read progress, logs, artifacts, and lifecycle events for a training run.

  training cancel --run-id <id> --reason <text> [--approve]
      Request cooperative cancellation only when --approve is explicit.

  workflow compile
  workflow run --file <dataset> [--workflow-version 1.0.0|2.0.0]
      V2 is the default; use 1.0.0 only for legacy compatibility.
  workflow resume --run-id <id> [--answers <json> | --columns <json>]
  workflow resume --run-id <id> [--dataset-confirmation <json>]
  workflow resume --run-id <id> [--decision-answer <text>]
  workflow resume --run-id <id> [--approve | --reject]
  workflow trace --run-id <id>
  workflow replay --run-id <id>
      Compile and operate the durable event-first THETA training workflow.

  demo [--approve]
      Run a local end-to-end showcase. Without --approve, the write stops at
      the Hypha HumanPlanReview gate. Training is never started by this command.

Global options:
  --json      Print machine-readable JSON.
  -h, --help  Show help.

Examples:
  npm run cli -- dataset inspect --file fixtures/sample.jsonl
  npm run cli -- dataset detect-columns --file fixtures/sample.jsonl
  npm run cli -- dataset register --file fixtures/sample.jsonl
  npm run cli -- dataset explore --dataset-ref <dataset_ref>
  npm run cli -- dataset understanding --run-id <run_id>
  npm run cli -- dataset confirm --run-id <run_id> --file <confirmation.json>
  npm run cli -- models
  npm run cli -- recommend --profile fixtures/data-profile.json --columns fixtures/model-recommend-columns.json
  npm run cli -- plan validate --file <planner-v2-bundle.json>
  npm run cli -- plan create --file <planner-v2-bundle.json>
  npm run cli -- plan create --file <planner-v2-bundle.json> --approve
  npm run cli -- plan approve --plan-id <id> --plan-hash <hash> --approved-by local_user --approve
  npm run cli -- training dry-run --file <dry-run-request.json>
  npm run cli -- training start --file <training-start-request.json>
  npm run cli -- training status --run-id <id>
  npm run cli -- training cancel --run-id <id> --reason "User requested cancellation"
  npm run cli -- plan show --run-id theta-run-001
  npm run cli -- evidence show --run-id theta-run-001
  npm run cli -- rag status
  npm run cli -- demo
`;

const parseArguments = (args: string[]): ParsedArguments => {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf("=");
    if (equalsIndex > 2) {
      flags.set(
        argument.slice(2, equalsIndex),
        argument.slice(equalsIndex + 1),
      );
      continue;
    }

    const key = argument.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { positionals, flags };
};

const hasFlag = (parsed: ParsedArguments, name: string): boolean =>
  parsed.flags.get(name) === true;

const stringFlag = (
  parsed: ParsedArguments,
  name: string,
  options: { required?: boolean } = {},
): string | undefined => {
  const value = parsed.flags.get(name);
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (options.required) {
    throw new Error(`Missing required option --${name}.`);
  }
  return undefined;
};

const requiredStringFlag = (parsed: ParsedArguments, name: string): string => {
  const value = stringFlag(parsed, name, { required: true });
  if (value === undefined) {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
};

const integerFlag = (
  parsed: ParsedArguments,
  name: string,
): number | undefined => {
  const value = stringFlag(parsed, name);
  if (value === undefined) {
    return undefined;
  }
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Option --${name} must be a positive integer.`);
  }
  return parsedValue;
};

const readJsonObject = async (
  filename: string,
): Promise<Record<string, unknown>> => {
  const fullPath = resolve(process.cwd(), filename);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(fullPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read JSON file ${fullPath}: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`JSON file ${fullPath} must contain an object.`);
  }
  return parsed as Record<string, unknown>;
};

const requireCompleted = <T>(
  result: { status: string; output?: T; error?: unknown },
  operation: string,
): T => {
  if (result.status !== "completed" || result.output === undefined) {
    throw new Error(
      `${operation} failed: ${JSON.stringify(result.error ?? result.status)}`,
    );
  }
  return result.output;
};

const writeResult = (
  value: unknown,
  parsed: ParsedArguments,
  output: CliOutput,
  render: () => string,
): void => {
  output.write(
    hasFlag(parsed, "json") ? JSON.stringify(value, null, 2) : render(),
  );
};

const datasetInput = (parsed: ParsedArguments): ThetaDatasetFileInput => {
  const sampleSize = integerFlag(parsed, "sample-size");
  return {
    filePath: resolve(process.cwd(), requiredStringFlag(parsed, "file")),
    ...(sampleSize === undefined ? {} : { sampleSize }),
  };
};

const inspectDatasetCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const result = await runThetaDatasetInspect(datasetInput(parsed));
  const profile = requireCompleted(result, "Dataset inspection");
  writeResult(profile, parsed, output, () => {
    const rows = profile.columnProfiles.map(
      (column) =>
        `  ${column.name}: ${column.inferredType}, missing ${(
          column.missingSampleRatio * 100
        ).toFixed(1)}%, avg length ${column.avgLength}`,
    );
    return [
      `Dataset: ${profile.fileName}`,
      `Rows: ${profile.rowCount}`,
      `Columns: ${profile.columns.join(", ")}`,
      `Sample rows returned: ${profile.sampleRows.length}`,
      "Column profiles:",
      ...rows,
    ].join("\n");
  });
};

const detectDatasetColumnsCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const result = await runThetaDatasetDetectColumns(datasetInput(parsed));
  const detected = requireCompleted(result, "Dataset column detection");
  writeResult(detected, parsed, output, () => {
    const candidates = detected.textColumns.map(
      (column) =>
        `  ${column.name}: ${(column.score * 100).toFixed(0)}% - ${column.reason}`,
    );
    return [
      `Recommended text column: ${detected.recommendedTextColumn ?? "none"}`,
      `Time columns: ${detected.timeColumns.map((column) => column.name).join(", ") || "none"}`,
      `Metadata columns: ${
        detected.metadataColumns.map((column) => column.name).join(", ") ||
        "none"
      }`,
      "Text candidates:",
      ...candidates,
      ...detected.warnings.map((warning) => `Warning: ${warning}`),
    ].join("\n");
  });
};

const registerDatasetCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const runtimeDb = stringFlag(parsed, "runtime-db");
  const registry = new SQLiteDatasetRegistry(runtimeDb);
  try {
    const record = await registry.registerLocalFile(
      resolve(process.cwd(), requiredStringFlag(parsed, "file")),
      { userId: "local_user", workspaceId: "local_workspace" },
    );
    const result = {
      datasetRef: record.datasetRef,
      displayName: record.displayName,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
      suffix: record.suffix,
      createdAt: record.createdAt,
    };
    writeResult(result, parsed, output, () =>
      [
        "Dataset registered.",
        `Reference: ${result.datasetRef}`,
        `Name: ${result.displayName}`,
        `Format: ${result.suffix}`,
        `Size: ${result.sizeBytes} bytes`,
      ].join("\n"),
    );
  } finally {
    registry.close();
  }
};

const exploreDatasetCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const input: ThetaDatasetExploreInput = {
    datasetRef: requiredStringFlag(parsed, "dataset-ref"),
  };
  const result = await withWorkflowDbEnvironment(
    stringFlag(parsed, "runtime-db"),
    () => runThetaDatasetExplore(input),
  );
  const explored = requireCompleted(result, "Dataset exploration");
  writeResult(explored, parsed, output, () =>
    [
      `Dataset: ${explored.fileName}`,
      `Reference: ${explored.datasetRef}`,
      `Rows: ${explored.rowCount}`,
      `Columns: ${explored.columns.join(", ")}`,
      `Inferred domain: ${explored.inferredDomain.label} (${(
        explored.inferredDomain.confidence * 100
      ).toFixed(0)}%)`,
      `Sample rows: ${explored.sampleRows.length}`,
      `Redacted values: ${explored.redactionSummary.redactedValueCount}`,
      ...explored.qualityWarnings.map((warning) => `Warning: ${warning}`),
    ].join("\n"),
  );
};

const datasetUnderstandingCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const runId = requiredStringFlag(parsed, "run-id");
  const context = await new ThetaWorkflowService().conversationContext(
    runId,
    stringFlag(parsed, "runtime-db"),
  );
  if (!context.datasetFacts || !context.datasetUnderstanding) {
    throw new Error(
      `Run ${runId} has not produced a dataset understanding yet; current state is ${context.status.currentState ?? "unknown"}.`,
    );
  }
  const result = {
    runId,
    currentState: context.status.currentState,
    pendingActionRef: context.status.pendingActionRef,
    facts: context.datasetFacts,
    understanding: context.datasetUnderstanding,
    ...(context.datasetConfirmation
      ? { confirmation: context.datasetConfirmation }
      : {}),
  };
  writeResult(result, parsed, output, () => renderDatasetUnderstanding(context));
};

const confirmDatasetUnderstandingCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const runId = requiredStringFlag(parsed, "run-id");
  const confirmation = datasetConfirmationDraftSchema.parse(
    await readJsonObject(requiredStringFlag(parsed, "file")),
  );
  const runtimeDb = stringFlag(parsed, "runtime-db");
  const result = await new ThetaWorkflowService().resume({
    runId,
    ...(runtimeDb ? { runtimeDb } : {}),
    datasetConfirmation: confirmation,
    approvedBy: stringFlag(parsed, "approved-by") ?? "local_user",
  });
  writeResult(result, parsed, output, () =>
    [
      "Dataset understanding confirmed.",
      `Run: ${result.runId}`,
      `Current state: ${result.currentState ?? result.status}`,
      ...(result.pendingReason ? [`Next: ${result.pendingReason}`] : []),
    ].join("\n"),
  );
};

const renderDatasetUnderstanding = (
  context: ThetaWorkflowConversationContext,
): string => {
  const facts = context.datasetFacts!;
  const understanding = context.datasetUnderstanding!;
  const roleNames = (entries: Array<{ column: string }>): string =>
    entries.map((entry) => entry.column).join(", ") || "none";
  return [
    `Dataset: ${facts.fileName}`,
    `Rows: ${facts.rowCount}`,
    `Columns: ${facts.columns.map((column) => column.name).join(", ")}`,
    `Domain: ${understanding.domain.label} (${(
      understanding.domain.confidence * 100
    ).toFixed(0)}%)`,
    `Analysis unit: ${understanding.analysisUnit}`,
    `Text columns: ${roleNames(understanding.textColumns)}`,
    `Time columns: ${roleNames(understanding.timeColumns)}`,
    `ID columns: ${roleNames(understanding.idColumns)}`,
    `Metadata columns: ${roleNames(understanding.metadataColumns)}`,
    ...understanding.qualityWarnings.map((warning) => `Warning: ${warning}`),
    context.datasetConfirmation
      ? "Confirmation: recorded"
      : "Confirmation: required; use dataset confirm --file <confirmation.json>.",
  ].join("\n");
};

const withWorkflowDbEnvironment = async <T>(
  runtimeDb: string | undefined,
  action: () => Promise<T>,
): Promise<T> => {
  if (!runtimeDb) return action();
  const previous = process.env.THETA_WORKFLOW_DB;
  process.env.THETA_WORKFLOW_DB = resolve(process.cwd(), runtimeDb);
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.THETA_WORKFLOW_DB;
    else process.env.THETA_WORKFLOW_DB = previous;
  }
};

const catalogCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const result = await runThetaModelCatalog();
  const catalog = requireCompleted(result, "Model catalog");
  writeResult(catalog, parsed, output, () => {
    const rows = catalog.models.map(
      (model) =>
        `  ${model.id.padEnd(10)} ${model.name} [${model.type}]${
          model.runnable === false ? " (unavailable)" : ""
        }`,
    );
    return [`THETA models (${catalog.models.length})`, ...rows].join("\n");
  });
};

const recommendCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const profileFile = requiredStringFlag(parsed, "profile");
  const columnsFile = requiredStringFlag(parsed, "columns");
  const dataProfile = await readJsonObject(profileFile);
  const columnConfirmation = await readJsonObject(columnsFile);
  const maxTopics = integerFlag(parsed, "max-topics");
  const researchGoal = stringFlag(parsed, "goal");
  const input: ThetaModelRecommendInput = {
    dataProfile,
    columnConfirmation,
    ...(researchGoal === undefined ? {} : { researchGoal }),
    ...(maxTopics === undefined ? {} : { constraints: { maxTopics } }),
  };
  const result = await runThetaModelRecommend(input);
  const recommendation = requireCompleted(result, "Model recommendation");
  writeResult(recommendation, parsed, output, () => {
    const rows = recommendation.recommendations.map((item) => {
      const rank = typeof item.rank === "number" ? item.rank : "-";
      const modelId =
        typeof item.modelId === "string" ? item.modelId : "unknown";
      const score = typeof item.score === "number" ? item.score : "-";
      const reasons = Array.isArray(item.reasonCodes)
        ? item.reasonCodes.join("; ")
        : "";
      return `  ${rank}. ${modelId} (score ${score})${reasons ? ` - ${reasons}` : ""}`;
    });
    return ["Recommended models", ...rows].join("\n");
  });
};

const readPlanInput = async (
  parsed: ParsedArguments,
): Promise<ThetaPlanCreateInput> => {
  const filename = requiredStringFlag(parsed, "file");
  const value = await readJsonObject(filename);
  return value as unknown as ThetaPlanCreateInput;
};

const planValidationDataProfile = (
  planInput: ThetaPlanCreateInput,
): Record<string, unknown> => {
  const facts = planInput.facts as Record<string, unknown>;
  const columnProfiles = Array.isArray(facts.columns)
    ? facts.columns.filter(
        (column): column is Record<string, unknown> =>
          Boolean(column) && typeof column === 'object' && !Array.isArray(column),
      )
    : [];
  return {
    rowCount: facts.rowCount,
    columns: columnProfiles.map((column) => column.name),
    columnProfiles,
    languageDistribution: facts.languageDistribution,
    qualityWarnings: facts.qualityWarnings,
  };
};

const validatePlanCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const planInput = await readPlanInput(parsed);
  const input: ThetaPlanValidateInput = {
    plan: planInput.validatedPlan as ThetaPlanValidateInput['plan'],
    dataProfile: planValidationDataProfile(planInput),
  };
  const result = await runThetaPlanValidate(input);
  const validation = requireCompleted(result, "Plan validation");
  writeResult(validation, parsed, output, () =>
    [
      `Plan valid: ${validation.valid ? "yes" : "no"}`,
      `Errors: ${validation.errors.length ? validation.errors.join("; ") : "none"}`,
      `Warnings: ${validation.warnings.length ? validation.warnings.join("; ") : "none"}`,
    ].join("\n"),
  );
  if (!validation.valid) {
    process.exitCode = 2;
  }
};

const planInvocationKey = (input: ThetaPlanCreateInput): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
  return `theta-cli-plan-create-${digest}`;
};

const approvalInvocationKey = (input: ThetaPlanApproveInput): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
  return `theta-cli-plan-approve-${digest}`;
};

const trainingStartInvocationKey = (
  input: Omit<ThetaTrainingStartInput, "idempotencyKey">,
): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
  return `theta-cli-training-start-${digest}`;
};

const trainingCancelInvocationKey = (
  input: ThetaTrainingCancelInput,
): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
  return `theta-cli-training-cancel-${digest}`;
};

const createPlanCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const input = await readPlanInput(parsed);
  const invocationKey = planInvocationKey(input);
  const options = {
    invocationId: invocationKey,
    idempotencyKey: invocationKey,
  };

  if (!hasFlag(parsed, "approve")) {
    const result = await requestThetaPlanCreate(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === "human_review_required",
      message:
        "Review the plan, then rerun this command with --approve to write local state.",
    };
    writeResult(gate, parsed, output, () =>
      [
        `Plan creation status: ${result.status}`,
        "No state was written.",
        "After review, rerun with --approve.",
      ].join("\n"),
    );
    return;
  }

  const result = await runApprovedThetaPlanCreate(input, options);
  const created = requireCompleted(result, "Approved plan creation");
  writeResult(created, parsed, output, () =>
    [
      "Plan created after Hypha approval.",
      `Plan ID: ${created.planId}`,
      `Plan hash: ${created.planHash}`,
      `Plan version: ${created.planVersion}`,
    ].join("\n"),
  );
};

const approvePlanCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const approvalNote = stringFlag(parsed, "note");
  const input: ThetaPlanApproveInput = {
    planId: requiredStringFlag(parsed, "plan-id"),
    planHash: requiredStringFlag(parsed, "plan-hash"),
    approvedBy: requiredStringFlag(parsed, "approved-by"),
    ...(approvalNote === undefined ? {} : { approvalNote }),
  };
  const invocationKey = approvalInvocationKey(input);
  const options = {
    invocationId: invocationKey,
    idempotencyKey: invocationKey,
  };

  if (!hasFlag(parsed, "approve")) {
    const result = await requestThetaPlanApprove(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === "human_review_required",
      message:
        "Review the approval request, then rerun this command with --approve.",
    };
    writeResult(gate, parsed, output, () =>
      [
        `Plan approval status: ${result.status}`,
        "No approval record was written.",
        "After review, rerun with --approve.",
      ].join("\n"),
    );
    return;
  }

  const result = await runApprovedThetaPlanApprove(input, options);
  const approved = requireCompleted(result, "Approved plan approval");
  writeResult(approved, parsed, output, () =>
    [
      "Plan approved through Hypha governance.",
      `Approval ID: ${approved.approvalId}`,
      `Plan ID: ${approved.planId}`,
      `Approved by: ${approved.approvedBy}`,
    ].join("\n"),
  );
};

const trainingDryRunCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const request = (await readJsonObject(
    requiredStringFlag(parsed, "file"),
  )) as unknown as ThetaTrainingDryRunInput;
  const result = await runThetaTrainingDryRun(request);
  const dryRun = requireCompleted(result, "Training dry run");
  writeResult(dryRun, parsed, output, () => {
    const commands = dryRun.commands.map(
      (command, index) =>
        `  ${index + 1}. ${command.step}: ${command.argv.join(" ")}\n     cwd: ${command.cwd}`,
    );
    const artifacts = dryRun.expectedArtifacts.map(
      (artifact) => `  - ${artifact.kind}: ${artifact.path}`,
    );
    return [
      `Training dry run for ${dryRun.planId}`,
      `Preflight passed: ${dryRun.passed ? "yes" : "no"}`,
      `Dry-run hash: ${dryRun.dryRunHash}`,
      "Commands:",
      ...commands,
      "Expected artifacts:",
      ...artifacts,
      "No training process was started.",
    ].join("\n");
  });
};

const trainingStartCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const loaded = (await readJsonObject(
    requiredStringFlag(parsed, "file"),
  )) as unknown as ThetaTrainingStartInput;
  const generatedKey = trainingStartInvocationKey({
    plan: loaded.plan,
    planReview: loaded.planReview,
    dryRun: loaded.dryRun,
    trainingReview: loaded.trainingReview,
  });
  const input: ThetaTrainingStartInput = {
    ...loaded,
    idempotencyKey:
      stringFlag(parsed, "idempotency-key") ??
      loaded.idempotencyKey ??
      generatedKey,
  };
  const options = {
    invocationId: input.idempotencyKey,
    idempotencyKey: input.idempotencyKey,
  };

  if (!hasFlag(parsed, "approve")) {
    const result = await requestThetaTrainingStart(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === "human_review_required",
      processStarted: false,
      message:
        "Review the run details, then rerun this command with --approve.",
    };
    writeResult(gate, parsed, output, () =>
      [
        `Training start status: ${result.status}`,
        "No training process was started.",
        "After review, rerun with --approve.",
      ].join("\n"),
    );
    return;
  }

  const result = await runApprovedThetaTrainingStart(input, options);
  const started = requireCompleted(result, "Approved training start");
  writeResult(started, parsed, output, () =>
    [
      "Training start approved through Hypha governance.",
      `Run ID: ${started.trainingRunId}`,
      `Status: ${started.status}`,
      `Process started: ${started.processStarted ? "yes" : "no"}`,
      `PID: ${String(started.pid ?? "not reported")}`,
    ].join("\n"),
  );
};

const trainingStatusCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const logLimit = integerFlag(parsed, "log-limit");
  const result = await runThetaTrainingStatus({
    trainingRunId: requiredStringFlag(parsed, "run-id"),
    ...(logLimit === undefined ? {} : { logLimit }),
  });
  const status = requireCompleted(result, "Training status");
  writeResult(status, parsed, output, () => {
    if (!status.found) {
      return [
        `Training run: ${status.trainingRunId}`,
        "Status: not found",
      ].join("\n");
    }
    return [
      `Training run: ${status.trainingRunId}`,
      `Status: ${status.status}`,
      `Attempt: ${status.receipt.attempt}`,
      `Progress: ${String(status.receipt.progress)}%`,
      `Current step: ${status.receipt.currentStep}`,
      `PID: ${String(status.receipt.pid ?? "not running")}`,
      `Bound artifacts: ${status.receipt.resultArtifacts.length}`,
      `Events: ${status.events.length}`,
      `Recent log lines: ${status.logs.length}`,
      ...status.logs.map((line) => `  ${line}`),
    ].join("\n");
  });
};

const trainingCancelCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const input: ThetaTrainingCancelInput = {
    trainingRunId: requiredStringFlag(parsed, "run-id"),
    reason: requiredStringFlag(parsed, "reason"),
  };
  const invocationKey = trainingCancelInvocationKey(input);
  const options = {
    invocationId: invocationKey,
    idempotencyKey: invocationKey,
  };

  if (!hasFlag(parsed, "approve")) {
    const result = await requestThetaTrainingCancel(input, options);
    const gate = {
      status: result.status,
      toolId: result.toolId,
      approvalRequired: result.status === "human_review_required",
      cancellationRecorded: false,
      message:
        "Review the cancellation reason, then rerun this command with --approve.",
    };
    writeResult(gate, parsed, output, () =>
      [
        `Training cancellation status: ${result.status}`,
        "No cancellation was recorded.",
        "After review, rerun with --approve.",
      ].join("\n"),
    );
    return;
  }

  const result = await runApprovedThetaTrainingCancel(input, options);
  const cancelled = requireCompleted(result, "Approved training cancellation");
  writeResult(cancelled, parsed, output, () =>
    [
      "Training cancellation processed through Hypha governance.",
      `Run ID: ${cancelled.trainingRunId}`,
      `Status: ${cancelled.status}`,
      `Changed: ${cancelled.changed ? "yes" : "no"}`,
      `Operator: ${cancelled.cancellation.operator}`,
      `Target PID: ${String(cancelled.cancellation.targetPid ?? "not running")}`,
      `Graceful stop: ${cancelled.cancellation.gracefulResult}`,
      `Forced stop: ${cancelled.cancellation.forcedResult}`,
      `Message: ${cancelled.message}`,
    ].join("\n"),
  );
};

const demoProfile: Record<string, unknown> = {
  rowCount: 240,
  columns: ["content", "created_at", "source"],
  recommendedTextColumn: "content",
  textColumns: [{ name: "content" }],
  timeColumns: [{ name: "created_at" }],
  metadataColumns: [{ name: "source" }],
  columnProfiles: [{ name: "content", avgLength: 92 }],
};

const demoColumnConfirmation: Record<string, unknown> = {
  schemaVersion: "1.0.0",
  datasetSha256: "a".repeat(64),
  textColumns: ["content"],
  timeColumn: "created_at",
  idColumn: null,
  covariateColumns: [],
  metadataColumns: ["source"],
  groupingColumns: ["source"],
  evaluationLabelColumns: [],
  confirmedBy: "theta-demo",
  confirmedAt: "2026-08-04T00:00:00.000Z",
};

const demoCommand = async (
  parsed: ParsedArguments,
  output: CliOutput,
): Promise<void> => {
  const catalog = requireCompleted(
    await runThetaModelCatalog(),
    "Demo model catalog",
  );
  const recommendation = requireCompleted(
    await runThetaModelRecommend({
      dataProfile: demoProfile,
      columnConfirmation: demoColumnConfirmation,
      researchGoal: "time trend topic modeling",
      constraints: { maxTopics: 12 },
    }),
    "Demo model recommendation",
  );
  const result = {
    runner: "Hypha GovernedToolRunner",
    modelCount: catalog.models.length,
    topRecommendation: recommendation.recommendations[0]?.modelId ?? null,
    nextGate: "HumanPlanReview",
    trainingStarted: false,
  };
  writeResult(result, parsed, output, () =>
    [
      "THETA CLI governed demo",
      `1. Model catalog: ${result.modelCount} models`,
      `2. Recommendation: ${String(result.topRecommendation)}`,
      "3. This read-only demo does not create a plan.",
      `4. Next gate in a real run: ${result.nextGate}`,
      "5. Training process started: no",
    ].join("\n"),
  );
};

export const runCli = async (
  args: string[],
  output: CliOutput = consoleOutput,
): Promise<number> => {
  try {
    const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
    const parsed = parseArguments(normalizedArgs);
    if (hasFlag(parsed, "help") || parsed.positionals.length === 0) {
      output.write(helpText);
      return 0;
    }

    if (isThetaAgentCommand(normalizedArgs)) {
      return runThetaAgentCliCommand(normalizedArgs, output);
    }

    const [command, subcommand, ...extraPositionals] = parsed.positionals;
    if (extraPositionals.length > 0) {
      throw new Error(`Unexpected arguments: ${extraPositionals.join(" ")}`);
    }

    if (command === "dataset" && subcommand === "inspect") {
      await inspectDatasetCommand(parsed, output);
      return 0;
    }
    if (command === "dataset" && subcommand === "detect-columns") {
      await detectDatasetColumnsCommand(parsed, output);
      return 0;
    }
    if (command === "dataset" && subcommand === "register") {
      await registerDatasetCommand(parsed, output);
      return 0;
    }
    if (command === "dataset" && subcommand === "explore") {
      await exploreDatasetCommand(parsed, output);
      return 0;
    }
    if (command === "dataset" && subcommand === "understanding") {
      await datasetUnderstandingCommand(parsed, output);
      return 0;
    }
    if (command === "dataset" && subcommand === "confirm") {
      await confirmDatasetUnderstandingCommand(parsed, output);
      return 0;
    }
    if (command === "models" && subcommand === undefined) {
      await catalogCommand(parsed, output);
      return 0;
    }
    if (command === "recommend" && subcommand === undefined) {
      await recommendCommand(parsed, output);
      return 0;
    }
    if (command === "plan" && subcommand === "validate") {
      await validatePlanCommand(parsed, output);
      return process.exitCode === 2 ? 2 : 0;
    }
    if (command === "plan" && subcommand === "create") {
      await createPlanCommand(parsed, output);
      return 0;
    }
    if (command === "plan" && subcommand === "approve") {
      await approvePlanCommand(parsed, output);
      return 0;
    }
    if (command === "training" && subcommand === "dry-run") {
      await trainingDryRunCommand(parsed, output);
      return 0;
    }
    if (command === "training" && subcommand === "start") {
      await trainingStartCommand(parsed, output);
      return 0;
    }
    if (command === "training" && subcommand === "status") {
      await trainingStatusCommand(parsed, output);
      return 0;
    }
    if (command === "training" && subcommand === "cancel") {
      await trainingCancelCommand(parsed, output);
      return 0;
    }
    if (command === "workflow" && subcommand !== undefined) {
      return runThetaWorkflowCliCommand(normalizedArgs.slice(1), output);
    }
    if (command === "demo" && subcommand === undefined) {
      await demoCommand(parsed, output);
      return 0;
    }

    throw new Error(`Unknown command: ${parsed.positionals.join(" ")}`);
  } catch (error) {
    output.writeError(renderUserError(error));
    return 1;
  }
};

const isMainModule =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  loadThetaProjectEnvironment();
  const exitCode = await runCli(process.argv.slice(2));
  if (process.exitCode === undefined) {
    process.exitCode = exitCode;
  }
}
