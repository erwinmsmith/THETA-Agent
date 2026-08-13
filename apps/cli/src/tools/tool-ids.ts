export const THETA_TOOL_IDS = {
  datasetInspect: "theta.dataset.inspect",
  datasetExplore: "theta.dataset.explore",
  datasetUnderstandingLanguage: "theta.dataset.understanding.language",
  datasetDetectColumns: "theta.dataset.detect_columns",
  datasetCleanPreview: "theta.dataset.clean_preview",
  modelCatalog: "theta.model.catalog",
  modelRecommend: "theta.model.recommend",
  planPropose: "theta.plan.propose",
  planValidate: "theta.plan.validate",
  planCreate: "theta.plan.create",
  planApprove: "theta.plan.approve",
  trainingDryRun: "theta.training.dry_run",
  trainingStart: "theta.training.start",
  trainingStatus: "theta.training.status",
  trainingCancel: "theta.training.cancel",
  resultsList: "theta.results.list",
  resultsSummarize: "theta.results.summarize",
  ragIndex: "theta.rag.index",
  ragStatus: "theta.rag.status",
  ragSearch: "theta.rag.search",
  languageGenerate: "theta.language.generate",
  conversationLanguage: "theta.conversation.language",
  eventsExport: "theta.events.export",
  eventsReplay: "theta.events.replay"
} as const;

export type ThetaToolId = (typeof THETA_TOOL_IDS)[keyof typeof THETA_TOOL_IDS];

export const THETA_PERMISSION_SCOPES = {
  datasetRead: "theta:dataset:read",
  datasetWrite: "theta:dataset:write",
  modelRead: "theta:model:read",
  planRead: "theta:plan:read",
  planWrite: "theta:plan:write",
  planApprove: "theta:plan:approve",
  trainingRead: "theta:training:read",
  trainingWrite: "theta:training:write",
  resultsRead: "theta:results:read",
  ragRead: "theta:rag:read",
  ragWrite: "theta:rag:write",
  inferenceUse: "theta:inference:use",
  eventsRead: "theta:events:read"
} as const;
