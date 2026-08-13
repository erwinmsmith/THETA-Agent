import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import {
  thetaToolsPackageRoot,
  thetaUpstreamRoot,
} from "../repository-paths.js";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  modelCapabilityCardSchema,
  type CapabilityCatalogModel,
  type CapabilityAuditIssue,
  type CapabilityAuditReport,
  type ModelCapabilityCard,
} from "./contracts.js";

const CORE_MODEL_IDS = [
  "lda",
  "btm",
  "hdp",
  "dtm",
  "stm",
  "bertopic",
  "theta",
] as const;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultAgentRoot = path.resolve(moduleDirectory, "..", "..");

export interface CapabilityRegistryOptions {
  agentRoot?: string;
  cardsDirectory?: string;
}

export class CapabilityRegistry {
  readonly agentRoot: string;
  readonly cardsDirectory: string;
  readonly cards: readonly ModelCapabilityCard[];
  private readonly cardsById: ReadonlyMap<string, ModelCapabilityCard>;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.agentRoot = path.resolve(options.agentRoot ?? defaultAgentRoot);
    this.cardsDirectory = path.resolve(
      options.cardsDirectory ??
        path.join(this.agentRoot, "knowledge", "capabilities", "models"),
    );
    this.cards = loadCards(this.cardsDirectory);
    this.cardsById = new Map(this.cards.map((card) => [card.modelId, card]));
  }

  get(modelId: string): ModelCapabilityCard | undefined {
    return this.cardsById.get(modelId.toLowerCase());
  }

  require(modelId: string): ModelCapabilityCard {
    const card = this.get(modelId);
    if (!card) {
      throw new Error(`Capability Card not found for model '${modelId}'.`);
    }
    return card;
  }

  plannerEligibleModelIds(): string[] {
    return this.cards
      .filter(
        (card) =>
          card.planner.eligible &&
          card.maturity !== "incomplete" &&
          card.maturity !== "unavailable",
      )
      .map((card) => card.modelId)
      .sort();
  }

  auditCatalog(models: readonly CapabilityCatalogModel[]): CapabilityAuditReport {
    const issues: CapabilityAuditIssue[] = [];
    const modelsById = new Map(
      models.map((model) => [model.id.toLowerCase(), model]),
    );

    for (const modelId of CORE_MODEL_IDS) {
      if (!this.cardsById.has(modelId)) {
        issues.push({
          severity: "error",
          code: "CORE_CAPABILITY_CARD_MISSING",
          modelId,
          message: `Core model '${modelId}' has no Capability Card.`,
        });
      }
    }

    for (const card of this.cards) {
      const catalogModel = modelsById.get(card.modelId);
      if (!catalogModel) {
        issues.push({
          severity: "error",
          code: "CARD_MODEL_NOT_IN_CATALOG",
          modelId: card.modelId,
          message: `Capability Card model '${card.modelId}' is absent from the THETA catalog.`,
        });
        continue;
      }
      if (card.planner.eligible && catalogModel.runnable !== true) {
        issues.push({
          severity: "error",
          code: "PLANNER_MODEL_NOT_RUNNABLE",
          modelId: card.modelId,
          message: `Planner-eligible model '${card.modelId}' is not runnable in run_pipeline.py.`,
        });
      }
      if (
        card.planner.eligible &&
        (card.maturity === "incomplete" || card.maturity === "unavailable")
      ) {
        issues.push({
          severity: "error",
          code: "IMMATURE_MODEL_PLANNER_ELIGIBLE",
          modelId: card.modelId,
          message: `Model '${card.modelId}' is ${card.maturity} and cannot be Planner-eligible.`,
        });
      }
      if (card.maturity === "experimental") {
        issues.push({
          severity: "warning",
          code: "EXPERIMENTAL_MODEL_REQUIRES_DISCLOSURE",
          modelId: card.modelId,
          message: `Model '${card.modelId}' is executable but experimental; plans must disclose this boundary.`,
        });
      }
      compareStringSets(
        issues,
        card.modelId,
        "CATALOG_REQUIREMENTS_DRIFT",
        card.catalog.requires,
        catalogModel.requires,
        "requires",
      );
      compareStringSets(
        issues,
        card.modelId,
        "CATALOG_PARAMETERS_DRIFT",
        card.parameters.flatMap((parameter) =>
          parameter.catalogName ? [parameter.catalogName] : [],
        ),
        Object.keys(catalogModel.params),
        "parameter names",
      );
      this.auditCatalogParameterMetadata(issues, card, catalogModel);
      if (
        typeof catalogModel.autoTopics === "boolean" &&
        catalogModel.autoTopics !== card.catalog.autoTopics
      ) {
        issues.push({
          severity: "error",
          code: "CATALOG_AUTO_TOPICS_DRIFT",
          modelId: card.modelId,
          message: `Catalog autoTopics=${String(catalogModel.autoTopics)} differs from card autoTopics=${String(card.catalog.autoTopics)}.`,
        });
      }

      for (const sourceRef of card.audit.sourceRefs) {
        if (!existsSync(path.resolve(this.agentRoot, sourceRef))) {
          issues.push({
            severity: "error",
            code: "AUDIT_SOURCE_MISSING",
            modelId: card.modelId,
            message: `Audited source does not exist: ${sourceRef}.`,
          });
        }
      }
      const auditedSource = card.audit.sourceRefs
        .map((sourceRef) => path.resolve(this.agentRoot, sourceRef))
        .filter((sourcePath) => existsSync(sourcePath))
        .map((sourcePath) => readFileSync(sourcePath, "utf8"))
        .join("\n");
      const trainerFunction = card.implementation.trainerEntry.split(".").at(-1);
      if (
        trainerFunction &&
        !auditedSource.includes(`def ${trainerFunction}(`)
      ) {
        issues.push({
          severity: "error",
          code: "TRAINER_ENTRY_MISSING",
          modelId: card.modelId,
          message: `Trainer entry '${card.implementation.trainerEntry}' was not found in audited sources.`,
        });
      }
      if (!existsSync(path.resolve(this.agentRoot, card.implementation.modulePath))) {
        issues.push({
          severity: "error",
          code: "IMPLEMENTATION_MODULE_MISSING",
          modelId: card.modelId,
          message: `Implementation module does not exist: ${card.implementation.modulePath}.`,
        });
      }
      if (!card.artifacts.some((artifact) => artifact.required)) {
        issues.push({
          severity: "error",
          code: "REQUIRED_ARTIFACT_UNDECLARED",
          modelId: card.modelId,
          message: "At least one required result artifact must be declared.",
        });
      }
    }

    this.auditCompiledFlags(issues);

    const auditedModelIds = this.cards.map((card) => card.modelId).sort();
    const plannerEligibleModelIds = this.plannerEligibleModelIds();
    const plannerExcludedModelIds = auditedModelIds.filter(
      (modelId) => !plannerEligibleModelIds.includes(modelId),
    );
    const unauditedCatalogModelIds = [...modelsById.keys()]
      .filter((modelId) => !this.cardsById.has(modelId))
      .sort();
    for (const modelId of unauditedCatalogModelIds) {
      issues.push({
        severity: "warning",
        code: "CATALOG_MODEL_NOT_AUDITED",
        modelId,
        message: `Catalog model '${modelId}' is intentionally excluded until it receives a Capability Card.`,
      });
    }

    return {
      status: issues.some((issue) => issue.severity === "error")
        ? "fail"
        : "pass",
      auditedModelIds,
      plannerEligibleModelIds,
      plannerExcludedModelIds,
      unauditedCatalogModelIds,
      issues,
    };
  }

  private auditCompiledFlags(issues: CapabilityAuditIssue[]): void {
    const toolsPath = path.join(thetaToolsPackageRoot, "tools.py");
    const pipelinePath = path.join(
      thetaUpstreamRoot,
      "src",
      "models",
      "run_pipeline.py",
    );
    const toolsSource = existsSync(toolsPath)
      ? readFileSync(toolsPath, "utf8")
      : "";
    const pipelineSource = existsSync(pipelinePath)
      ? readFileSync(pipelinePath, "utf8")
      : "";

    for (const card of this.cards) {
      for (const parameter of card.parameters) {
        if (parameter.exposure !== "agent_compiled" || !parameter.trainFlag) {
          continue;
        }
        if (!toolsSource.includes(`"${parameter.trainFlag}"`)) {
          issues.push({
            severity: "error",
            code: "AGENT_FLAG_NOT_COMPILED",
            modelId: card.modelId,
            message: `${parameter.parameterId} declares ${parameter.trainFlag}, but tools.py does not compile that flag.`,
          });
        }
        if (!pipelineSource.includes(`'${parameter.trainFlag}'`)) {
          issues.push({
            severity: "error",
            code: "TRAIN_FLAG_NOT_ACCEPTED",
            modelId: card.modelId,
            message: `${parameter.parameterId} declares ${parameter.trainFlag}, but run_pipeline.py does not accept that flag.`,
          });
        }
      }
    }
  }

  private auditCatalogParameterMetadata(
    issues: CapabilityAuditIssue[],
    card: ModelCapabilityCard,
    catalogModel: CapabilityCatalogModel,
  ): void {
    for (const parameter of card.parameters) {
      if (!parameter.catalogName) continue;
      const rawCatalogParameter = catalogModel.params[parameter.catalogName];
      if (!isRecord(rawCatalogParameter)) continue;
      const catalogType = normalizeCatalogType(rawCatalogParameter.type);
      if (catalogType && catalogType !== parameter.valueType) {
        issues.push({
          severity: "error",
          code: "CATALOG_PARAMETER_TYPE_DRIFT",
          modelId: card.modelId,
          message: `${parameter.catalogName} type '${catalogType}' differs from card '${parameter.valueType}'.`,
        });
      }
      if (
        "default" in rawCatalogParameter &&
        !sameScalar(rawCatalogParameter.default, parameter.defaultValue)
      ) {
        issues.push({
          severity: "error",
          code: "CATALOG_PARAMETER_DEFAULT_DRIFT",
          modelId: card.modelId,
          message: `${parameter.catalogName} default '${String(rawCatalogParameter.default)}' differs from card '${String(parameter.defaultValue)}'.`,
        });
      }
      compareStringSets(
        issues,
        card.modelId,
        "CATALOG_PARAMETER_CHOICES_DRIFT",
        parameter.choices.map(String),
        Array.isArray(rawCatalogParameter.choices)
          ? rawCatalogParameter.choices.map(String)
          : [],
        `${parameter.catalogName} choices`,
      );
    }
  }
}

const loadCards = (cardsDirectory: string): readonly ModelCapabilityCard[] => {
  if (!existsSync(cardsDirectory)) {
    throw new Error(`Capability Card directory does not exist: ${cardsDirectory}.`);
  }
  const filenames = readdirSync(cardsDirectory)
    .filter((filename) => /\.ya?ml$/i.test(filename))
    .sort();
  if (filenames.length === 0) {
    throw new Error(`No Capability Cards found in ${cardsDirectory}.`);
  }
  const cards = filenames.map((filename) => {
    const fullPath = path.join(cardsDirectory, filename);
    try {
      return modelCapabilityCardSchema.parse(
        parseYaml(readFileSync(fullPath, "utf8")),
      );
    } catch (error) {
      throw new Error(
        `Invalid Capability Card '${filename}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.modelId)) {
      throw new Error(`Duplicate Capability Card for '${card.modelId}'.`);
    }
    seen.add(card.modelId);
  }
  return cards;
};

const compareStringSets = (
  issues: CapabilityAuditIssue[],
  modelId: string,
  code: string,
  cardValues: readonly string[],
  catalogValues: readonly string[],
  label: string,
): void => {
  const cardSet = [...new Set(cardValues.map((value) => value.toLowerCase()))].sort();
  const catalogSet = [
    ...new Set(catalogValues.map((value) => value.toLowerCase())),
  ].sort();
  if (cardSet.join("\0") === catalogSet.join("\0")) return;
  issues.push({
    severity: "error",
    code,
    modelId,
    message: `Capability Card ${label} [${cardSet.join(", ")}] differ from catalog [${catalogSet.join(", ")}].`,
  });
};

const normalizeCatalogType = (
  value: unknown,
): "integer" | "number" | "string" | "boolean" | null => {
  switch (String(value ?? "").toLowerCase()) {
    case "int":
    case "integer":
      return "integer";
    case "float":
    case "number":
      return "number";
    case "str":
    case "string":
      return "string";
    case "bool":
    case "boolean":
      return "boolean";
    default:
      return null;
  }
};

const sameScalar = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) ||
  (typeof left === "number" &&
    typeof right === "number" &&
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    left === right);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
