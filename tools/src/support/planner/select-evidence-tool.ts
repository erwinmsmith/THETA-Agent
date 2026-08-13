import type { InferenceToolDescriptor } from "@hypha/inference";

export const SELECT_EVIDENCE_TOOL_NAME = "select_evidence";

export interface EvidenceSelectionTarget {
  targetId: string;
  claim: string;
  provisionalAliases: string[];
  kind: "model" | "parameter" | "preprocessing" | "evaluation" | "experiment_protocol";
  modelId?: string;
  parameterId?: string;
}

export interface SelectedEvidence {
  targetId: string;
  evidenceIds: string[];
}

export class EvidenceSelectionError extends Error {
  constructor(
    message: string,
    readonly receiptCode:
      | "EVIDENCE_ID_NOT_IN_RETRIEVAL_SET"
      | "EVIDENCE_ID_NOT_FOUND"
      | "EVIDENCE_TARGET_MISMATCH"
      | "EVIDENCE_MODEL_MISMATCH"
      | "EVIDENCE_DUPLICATE"
      | "EVIDENCE_INSUFFICIENT_SUPPORT" = "EVIDENCE_INSUFFICIENT_SUPPORT",
    readonly targetId: string | null = null,
    readonly evidenceId: string | null = null,
  ) {
    super(message);
  }

  readonly code = "evidence_violation";
}

export const selectEvidenceToolDescriptor = (
  aliases: ReadonlyMap<string, string>,
  targets: readonly EvidenceSelectionTarget[],
  compatibleAliases?: ReadonlyMap<string, readonly string[]>,
): InferenceToolDescriptor => ({
  id: "theta.planner.select_evidence",
  name: SELECT_EVIDENCE_TOOL_NAME,
  description:
    "Select evidence for every Planner decision from the current bounded Evidence Bundle. Use only the provided E aliases; use an empty aliases array when a decision is not grounded.",
  inputSchema: {
    type: "object",
    required: ["selections"],
    properties: {
      selections: {
        type: "array",
        minItems: targets.length,
        maxItems: targets.length,
        items: {
          oneOf: targets.map((target) => {
            const allowed = compatibleAliases?.get(target.targetId) ?? [...aliases.keys()];
            return {
              type: "object",
              required: ["targetId", "aliases"],
              properties: {
                targetId: { type: "string", enum: [target.targetId] },
                aliases: {
                  type: "array",
                  maxItems: Math.min(5, allowed.length),
                  uniqueItems: true,
                  items: allowed.length
                    ? { type: "string", enum: [...allowed] }
                    : { type: "string" },
                },
              },
              additionalProperties: false,
            };
          }),
        },
      },
    },
    additionalProperties: false,
  },
});

export const executeSelectEvidence = (
  output: unknown,
  aliases: ReadonlyMap<string, string>,
  targets: readonly EvidenceSelectionTarget[],
): SelectedEvidence[] => {
  const root = record(output);
  if (root.kind !== "tool_calls") {
    throw new EvidenceSelectionError(
      "The selected provider must call select_evidence; plain text or JSON evidence selection is not accepted.",
    );
  }
  const calls = array(root.toolCalls);
  if (calls.length !== 1) {
    throw new EvidenceSelectionError("The selected provider must call select_evidence exactly once.");
  }
  const call = record(calls[0]);
  if (call.name !== SELECT_EVIDENCE_TOOL_NAME) {
    throw new EvidenceSelectionError(
      `Unexpected evidence tool '${String(call.name ?? "")}'.`,
    );
  }
  const args = record(call.arguments);
  const selections = array(args.selections);
  if (selections.length !== targets.length) {
    throw new EvidenceSelectionError(
      `select_evidence must bind all ${targets.length} decision targets.`,
    );
  }

  const allowedTargets = new Set(targets.map((item) => item.targetId));
  const seenTargets = new Set<string>();
  const result: SelectedEvidence[] = [];
  for (const rawSelection of selections) {
    const selection = record(rawSelection);
    const targetId = requiredString(selection.targetId, "selection.targetId");
    if (!allowedTargets.has(targetId)) {
      throw new EvidenceSelectionError(
        `Unknown evidence target '${targetId}'.`,
        "EVIDENCE_TARGET_MISMATCH",
        targetId,
      );
    }
    if (seenTargets.has(targetId)) {
      throw new EvidenceSelectionError(
        `Duplicate evidence target '${targetId}'.`,
        "EVIDENCE_DUPLICATE",
        targetId,
      );
    }
    seenTargets.add(targetId);
    if (!Array.isArray(selection.aliases) || selection.aliases.length > 5) {
      throw new EvidenceSelectionError(
        `Evidence aliases for '${targetId}' must be an array with at most five items.`,
      );
    }
    const selectedAliases = selection.aliases.map((value) =>
      requiredString(value, `${targetId}.aliases`),
    );
    if (new Set(selectedAliases).size !== selectedAliases.length) {
      throw new EvidenceSelectionError(
        `Duplicate evidence alias for '${targetId}'.`,
        "EVIDENCE_DUPLICATE",
        targetId,
      );
    }
    const evidenceIds = selectedAliases.map((alias) => {
      const evidenceId = aliases.get(alias);
      if (!evidenceId) {
        throw new EvidenceSelectionError(
          `Evidence alias '${alias}' is outside the current Evidence Bundle.`,
          "EVIDENCE_ID_NOT_IN_RETRIEVAL_SET",
          targetId,
          alias,
        );
      }
      return evidenceId;
    });
    result.push({ targetId, evidenceIds });
  }
  return result;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new EvidenceSelectionError(`${label} must be a non-empty string.`);
  }
  return value.trim();
};
