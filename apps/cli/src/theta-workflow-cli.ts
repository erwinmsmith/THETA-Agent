import { readFile } from "node:fs/promises";
import path from "node:path";
import { THETA_APPROVAL_KEYS } from "@theta-agent/agent";
import {
  ThetaWorkflowService,
  type ThetaWorkflowInput,
} from "@theta-agent/agent";
import {
  renderUserError,
  renderValue,
} from "./presentation/terminal-renderer.js";

interface WorkflowCliOutput {
  write(message: string): void;
  writeError(message: string): void;
}

interface ParsedWorkflowArguments {
  command?: string;
  flags: Map<string, string | boolean>;
}

export const thetaWorkflowHelp = `THETA workflow commands:
  workflow compile
      Compile the THETA DomainPack and print the FSM contract summary.

  workflow run --file <dataset> [--run-id <id>] [--runtime-db <path>]
      Start the event-first V2 workflow. It registers the local file and uses
      an opaque dataset reference. Use --workflow-version 1.0.0 only for
      legacy compatibility.
      Add --approve-plans for HumanPlanReview. Add
      --approve-training as well to permit the external training start.

  workflow resume --run-id <id> [--approve | --reject] [--runtime-db <path>]
      Resume a durable Run and optionally resolve an approval wait.
      Use --answers <json> for research clarification or --columns <json>
      for legacy column confirmation. V2 accepts --dataset-confirmation <json>,
      --decision-answer <text>, or --plan-adjustment <json>.

  workflow status --run-id <id> [--runtime-db <path>]
      Derive the current Run state from canonical Runtime events.

  workflow trace --run-id <id> [--runtime-db <path>]
      Print canonical orchestration events and governed tool trace events.

  workflow replay --run-id <id> [--runtime-db <path>]
      Derive a deterministic replay fixture from persisted events.`;

export const runThetaWorkflowCliCommand = async (
  args: string[],
  output: WorkflowCliOutput,
): Promise<number> => {
  try {
    const parsed = parseWorkflowArguments(args);
    if (!parsed.command || flag(parsed, "help")) {
      output.write(thetaWorkflowHelp);
      return 0;
    }

    const service = new ThetaWorkflowService();
    const runtimeDb = stringFlag(parsed, "runtime-db");
    const json = flag(parsed, "json");

    if (parsed.command === "compile") {
      write(service.compileSummary(), json, output);
      return 0;
    }
    if (parsed.command === "run") {
      const input = await workflowInput(parsed);
      const approvalKeys: string[] = [];
      if (flag(parsed, "approve-plans")) {
        approvalKeys.push(THETA_APPROVAL_KEYS.planReview);
      }
      if (flag(parsed, "approve-training")) {
        if (!flag(parsed, "approve-plans")) {
          throw new Error("--approve-training requires --approve-plans.");
        }
        approvalKeys.push(THETA_APPROVAL_KEYS.trainingReview);
      }
      const result = await service.run({
        input,
        ...(stringFlag(parsed, "run-id")
          ? { runId: stringFlag(parsed, "run-id") }
          : {}),
        ...(runtimeDb ? { runtimeDb } : {}),
        approvalKeys,
        approvedBy: stringFlag(parsed, "approved-by") ?? "local_user",
      });
      write(result, json, output);
      return result.disposition === "failed" ? 2 : 0;
    }
    if (parsed.command === "resume") {
      if (flag(parsed, "approve") && flag(parsed, "reject")) {
        throw new Error("--approve and --reject cannot be used together.");
      }
      const researchAnswers = await optionalJsonFlag(parsed, "answers");
      const columnConfirmation = await optionalJsonFlag(parsed, "columns");
      const datasetConfirmation = await optionalJsonFlag(
        parsed,
        "dataset-confirmation",
      );
      const planAdjustment = await optionalJsonFlag(parsed, "plan-adjustment");
      const decisionAnswer = stringFlag(parsed, "decision-answer");
      const result = await service.resume({
        runId: requiredFlag(parsed, "run-id"),
        ...(runtimeDb ? { runtimeDb } : {}),
        approve: flag(parsed, "approve"),
        reject: flag(parsed, "reject"),
        approvedBy: stringFlag(parsed, "approved-by") ?? "local_user",
        ...(researchAnswers ? { researchAnswers } : {}),
        ...(columnConfirmation
          ? {
              columnConfirmation: columnConfirmation as {
                textColumns: string[];
                timeColumn: string | null;
                idColumn: string | null;
                covariateColumns: string[];
                metadataColumns: string[];
              },
            }
          : {}),
        ...(datasetConfirmation
          ? {
              datasetConfirmation: datasetConfirmation as {
                status: "confirmed" | "corrected";
                domainLabel: string;
                analysisUnit: string;
                textColumns: string[];
                timeColumns: string[];
                idColumns: string[];
                metadataColumns: string[];
              },
            }
          : {}),
        ...(decisionAnswer ? { decisionAnswer } : {}),
        ...(planAdjustment ? { planAdjustment } : {}),
      });
      write(result, json, output);
      return result.disposition === "failed" ? 2 : 0;
    }
    if (parsed.command === "status") {
      const status = await service.status(
        requiredFlag(parsed, "run-id"),
        runtimeDb,
      );
      write(status, json, output);
      return 0;
    }
    if (parsed.command === "trace") {
      const evidence = await service.evidence(
        requiredFlag(parsed, "run-id"),
        runtimeDb,
      );
      write(evidence, json, output);
      return 0;
    }
    if (parsed.command === "replay") {
      const replay = await service.replay(
        requiredFlag(parsed, "run-id"),
        runtimeDb,
      );
      write(replay, json, output);
      return 0;
    }

    throw new Error(`Unknown workflow command: ${parsed.command}`);
  } catch (error) {
    output.writeError(renderUserError(error));
    return 1;
  }
};

const workflowInput = async (
  parsed: ParsedWorkflowArguments,
): Promise<ThetaWorkflowInput> => {
  const inputFile = stringFlag(parsed, "input");
  if (inputFile) {
    const value = JSON.parse(
      await readFile(path.resolve(inputFile), "utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("--input must contain a JSON object.");
    }
    const input = value as ThetaWorkflowInput;
    const workflowVersion = parseWorkflowVersion(
      stringFlag(parsed, "workflow-version") ??
        input.workflowVersion ??
        "2.0.0",
    );
    return {
      ...input,
      filePath: path.resolve(process.cwd(), input.filePath),
      workflowVersion,
    };
  }
  return {
    filePath: path.resolve(process.cwd(), requiredFlag(parsed, "file")),
    workflowVersion: parseWorkflowVersion(
      stringFlag(parsed, "workflow-version") ?? "2.0.0",
    ),
    ...(stringFlag(parsed, "dataset-id")
      ? { datasetId: stringFlag(parsed, "dataset-id") }
      : {}),
    ...(stringFlag(parsed, "goal")
      ? { researchGoal: stringFlag(parsed, "goal") }
      : {}),
    ...(integerFlag(parsed, "sample-size")
      ? { sampleSize: integerFlag(parsed, "sample-size") }
      : {}),
    ...(stringFlag(parsed, "planner-mode")
      ? {
          plannerMode: parsePlannerMode(
            requiredFlag(parsed, "planner-mode"),
          ),
        }
      : {}),
  };
};

const parseWorkflowVersion = (
  value: string,
): "1.0.0" | "2.0.0" => {
  if (value !== "1.0.0" && value !== "2.0.0") {
    throw new Error("--workflow-version must be 1.0.0 or 2.0.0.");
  }
  return value;
};

const parsePlannerMode = (
  value: string,
): "deterministic" | "minimax" => {
  if (value !== "deterministic" && value !== "minimax") {
    throw new Error("--planner-mode must be deterministic or minimax.");
  }
  return value;
};

const parseWorkflowArguments = (args: string[]): ParsedWorkflowArguments => {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      if (command) throw new Error(`Unexpected workflow argument: ${value}`);
      command = value;
      continue;
    }
    const key = value.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
};

const write = (
  value: unknown,
  json: boolean,
  output: WorkflowCliOutput,
): void => {
  if (json) {
    output.write(JSON.stringify(value));
    return;
  }
  output.write(renderValue(value));
};

const flag = (parsed: ParsedWorkflowArguments, name: string): boolean =>
  parsed.flags.get(name) === true;

const stringFlag = (
  parsed: ParsedWorkflowArguments,
  name: string,
): string | undefined => {
  const value = parsed.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const requiredFlag = (
  parsed: ParsedWorkflowArguments,
  name: string,
): string => {
  const value = stringFlag(parsed, name);
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
};

const integerFlag = (
  parsed: ParsedWorkflowArguments,
  name: string,
): number | undefined => {
  const value = stringFlag(parsed, name);
  if (!value) return undefined;
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`Option --${name} must be a positive integer.`);
  }
  return parsedValue;
};

const optionalJsonFlag = async (
  parsed: ParsedWorkflowArguments,
  name: string,
): Promise<Record<string, unknown> | undefined> => {
  const filename = stringFlag(parsed, name);
  if (!filename) return undefined;
  const value = JSON.parse(
    await readFile(path.resolve(process.cwd(), filename), "utf8"),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--${name} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
};
