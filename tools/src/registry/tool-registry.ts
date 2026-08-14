import { ToolRegistry, type ToolSpec } from "@codesoul-co/hypha-tools";
import {
  thetaConversationLanguageHandler,
  thetaConversationLanguageToolSpec,
} from "../conversation-language-tool.js";
import {
  thetaDatasetDetectColumnsHandler,
  thetaDatasetDetectColumnsToolSpec,
} from "../dataset-detect-columns-tool.js";
import {
  thetaDatasetInspectHandler,
  thetaDatasetInspectToolSpec,
} from "../dataset-inspect-tool.js";
import {
  thetaDatasetExploreHandler,
  thetaDatasetExploreToolSpec,
} from '../dataset-explore-tool.js';
import {
  thetaDatasetUnderstandingLanguageHandler,
  thetaDatasetUnderstandingLanguageToolSpec,
} from '../dataset-understanding-language-tool.js';
import {
  thetaModelCatalogHandler,
  thetaModelCatalogToolSpec,
} from "../model-catalog-tool.js";
import {
  thetaModelRecommendHandler,
  thetaModelRecommendToolSpec,
} from "../model-recommend-tool.js";
import {
  thetaRagIndexHandler,
  thetaRagIndexToolSpec,
} from "../rag-index-tool.js";
import {
  thetaRagSearchHandler,
  thetaRagSearchToolSpec,
} from "../rag-search-tool.js";
import {
  thetaRagStatusHandler,
  thetaRagStatusToolSpec,
} from "../rag-status-tool.js";
import {
  thetaPlanApproveHandler,
  thetaPlanApproveToolSpec,
} from "../plan-approve-tool.js";
import {
  thetaPlanCreateHandler,
  thetaPlanCreateToolSpec,
} from "../plan-create-tool.js";
import {
  thetaPlanValidateHandler,
  thetaPlanValidateToolSpec,
} from "../plan-validate-tool.js";
import {
  thetaPlanProposeHandler,
  thetaPlanProposeToolSpec,
} from "../plan-propose-tool.js";
import {
  thetaTrainingDryRunHandler,
  thetaTrainingDryRunToolSpec,
} from "../training-dry-run-tool.js";
import {
  thetaTrainingCancelHandler,
  thetaTrainingCancelToolSpec,
} from "../training-cancel-tool.js";
import {
  thetaTrainingStartHandler,
  thetaTrainingStartToolSpec,
} from "../training-start-tool.js";
import {
  thetaTrainingStatusHandler,
  thetaTrainingStatusToolSpec,
} from "../training-status-tool.js";
import {
  thetaLanguageGenerateHandler,
  thetaLanguageGenerateToolSpec,
} from "../language-generate-tool.js";

export const registerThetaModelCatalogTool = (
  registry: ToolRegistry,
): ToolRegistry => {
  registry.register(thetaModelCatalogToolSpec, thetaModelCatalogHandler, {
    replace: true,
  });
  return registry;
};

export const thetaHyphaToolSpecs: readonly ToolSpec[] = Object.freeze([
  thetaDatasetInspectToolSpec,
  thetaDatasetExploreToolSpec,
  thetaDatasetUnderstandingLanguageToolSpec,
  thetaDatasetDetectColumnsToolSpec,
  thetaModelCatalogToolSpec,
  thetaModelRecommendToolSpec,
  thetaRagIndexToolSpec,
  thetaRagStatusToolSpec,
  thetaRagSearchToolSpec,
  thetaPlanProposeToolSpec,
  thetaPlanValidateToolSpec,
  thetaPlanCreateToolSpec,
  thetaPlanApproveToolSpec,
  thetaTrainingDryRunToolSpec,
  thetaTrainingStartToolSpec,
  thetaTrainingStatusToolSpec,
  thetaTrainingCancelToolSpec,
  thetaLanguageGenerateToolSpec,
  thetaConversationLanguageToolSpec,
]);

export const createAgentToolRegistry = (): ToolRegistry => {
  const registry = new ToolRegistry();
  registry.register(thetaDatasetInspectToolSpec, thetaDatasetInspectHandler, {
    replace: true,
  });
  registry.register(thetaDatasetExploreToolSpec, thetaDatasetExploreHandler, {
    replace: true,
  });
  registry.register(
    thetaDatasetUnderstandingLanguageToolSpec,
    thetaDatasetUnderstandingLanguageHandler,
    { replace: true },
  );
  registry.register(
    thetaDatasetDetectColumnsToolSpec,
    thetaDatasetDetectColumnsHandler,
    {
      replace: true,
    },
  );
  registerThetaModelCatalogTool(registry);
  registry.register(thetaModelRecommendToolSpec, thetaModelRecommendHandler, {
    replace: true,
  });
  registry.register(thetaRagIndexToolSpec, thetaRagIndexHandler, {
    replace: true,
  });
  registry.register(thetaRagStatusToolSpec, thetaRagStatusHandler, {
    replace: true,
  });
  registry.register(thetaRagSearchToolSpec, thetaRagSearchHandler, {
    replace: true,
  });
  registry.register(thetaPlanValidateToolSpec, thetaPlanValidateHandler, {
    replace: true,
  });
  registry.register(thetaPlanCreateToolSpec, thetaPlanCreateHandler, {
    replace: true,
  });
  registry.register(thetaPlanApproveToolSpec, thetaPlanApproveHandler, {
    replace: true,
  });
  registry.register(thetaTrainingDryRunToolSpec, thetaTrainingDryRunHandler, {
    replace: true,
  });
  registry.register(thetaTrainingStartToolSpec, thetaTrainingStartHandler, {
    replace: true,
  });
  registry.register(thetaTrainingStatusToolSpec, thetaTrainingStatusHandler, {
    replace: true,
  });
  registry.register(thetaTrainingCancelToolSpec, thetaTrainingCancelHandler, {
    replace: true,
  });
  registry.register(thetaLanguageGenerateToolSpec, thetaLanguageGenerateHandler, {
    replace: true,
  });
  registry.register(thetaPlanProposeToolSpec, thetaPlanProposeHandler, {
    replace: true,
  });
  registry.register(
    thetaConversationLanguageToolSpec,
    thetaConversationLanguageHandler,
    { replace: true },
  );
  return registry;
};

export const createThetaHyphaToolRegistry = createAgentToolRegistry;
