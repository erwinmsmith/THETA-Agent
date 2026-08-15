import type { PromptMessage } from '@codesoul-co/hypha-inference';
import { z } from 'zod';
import { createInferenceProviderFromEnv } from '@theta-agent/tools/support/providers/registry.js';
import { THETA_AGENT_MISSION_PROMPT } from '@theta-agent/tools/support/language/agent-identity.js';
import {
  datasetConfirmationDraftSchema,
  datasetFactsSchema,
  datasetUnderstandingDraftSchema,
  type DatasetConfirmationDraft,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
} from '@theta-agent/domain/dataset-understanding/contracts.js';
import { validateDatasetConfirmation } from './validator.js';

const correctionPatchSchema = z.object({
  domainLabel: z.string().min(1).max(200).optional(),
  analysisUnit: z.string().min(1).max(500).optional(),
  textColumns: z.array(z.string().min(1)).max(12).optional(),
  timeColumns: z.array(z.string().min(1)).max(12).optional(),
  idColumns: z.array(z.string().min(1)).max(12).optional(),
  metadataColumns: z.array(z.string().min(1)).max(24).optional(),
  groupColumns: z.array(z.string().min(1)).max(24).optional(),
  covariateColumns: z.array(z.string().min(1)).max(24).optional(),
  evaluationColumns: z.array(z.string().min(1)).max(24).optional(),
  ignoredColumns: z.array(z.string().min(1)).max(24).optional(),
  correctionSummary: z.string().min(1).max(500),
  evidenceSpans: z.array(z.string().min(1).max(300)).max(12).default([]),
}).strict();

export interface DatasetCorrectionResult {
  draft: DatasetConfirmationDraft;
  correctionSummary: string;
  evidenceSpans: string[];
  source: 'provider' | 'deterministic';
  fallbackReason?: string;
}

export class DatasetCorrectionService {
  async interpret(input: {
    facts: DatasetFacts;
    understanding: DatasetUnderstandingDraft;
    message: string;
  }): Promise<DatasetCorrectionResult> {
    const facts = datasetFactsSchema.parse(input.facts);
    const understanding = datasetUnderstandingDraftSchema.parse(input.understanding);
    const base = baseDraft(understanding);
    const provider = createInferenceProviderFromEnv({ timeoutMs: 90_000 });
    let providerError = provider ? '' : 'No language model provider is configured.';
    if (provider) {
      let validationErrors: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await provider.infer({
            runId: `theta-dataset-correction-${facts.datasetHash.slice(0, 16)}`,
            stepId: attempt === 0 ? 'interpret-dataset-correction' : 'repair-dataset-correction',
            modelAlias: provider.model,
            input: { messages: correctionMessages(facts, base, input.message, validationErrors) },
            options: {
              temperature: 0,
              maxTokens: 1000,
              extra: { toolChoice: 'none', jsonObject: true },
            },
            trace: false,
            metadata: { purpose: 'dataset_correction', datasetRef: facts.datasetRef },
          });
          const patch = correctionPatchSchema.parse(response.output);
          return finalizeCorrection(facts, base, patch, 'provider');
        } catch (error) {
          validationErrors = error instanceof z.ZodError
            ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            : [error instanceof Error ? error.message : String(error)];
          providerError = validationErrors.join('; ');
        }
      }
    }
    const patch = deterministicCorrectionPatch(facts, input.message);
    return finalizeCorrection(facts, base, patch, 'deterministic', providerError);
  }
}

const finalizeCorrection = (
  facts: DatasetFacts,
  base: DatasetConfirmationDraft,
  patch: z.infer<typeof correctionPatchSchema>,
  source: DatasetCorrectionResult['source'],
  fallbackReason?: string,
): DatasetCorrectionResult => {
    const draft = datasetConfirmationDraftSchema.parse({
      ...base,
      ...patch,
      status: 'corrected',
    });
    const candidate = {
      schemaVersion: '2.0.0' as const,
      datasetRef: facts.datasetRef,
      datasetHash: facts.datasetHash,
      ...draft,
      confirmedBy: 'pending-user-confirmation',
      confirmedAt: new Date().toISOString(),
    };
    const validation = validateDatasetConfirmation(candidate, facts);
    if (!validation.valid) throw new Error(validation.errors.join(' '));
    return {
      draft,
      correctionSummary: patch.correctionSummary,
      evidenceSpans: patch.evidenceSpans,
      source,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
};

const baseDraft = (understanding: DatasetUnderstandingDraft): DatasetConfirmationDraft =>
  datasetConfirmationDraftSchema.parse({
    status: 'confirmed',
    domainLabel: understanding.domain.label,
    analysisUnit: understanding.analysisUnit,
    textColumns: understanding.textColumns.map((entry) => entry.column).slice(0, 12),
    timeColumns: understanding.timeColumns.map((entry) => entry.column).slice(0, 12),
    idColumns: understanding.idColumns.map((entry) => entry.column).slice(0, 12),
    metadataColumns: understanding.metadataColumns.map((entry) => entry.column).slice(0, 24),
    groupColumns: understanding.groupColumns.map((entry) => entry.column).slice(0, 24),
    covariateColumns: understanding.covariateColumns.map((entry) => entry.column).slice(0, 24),
    evaluationColumns: understanding.evaluationColumns.map((entry) => entry.column).slice(0, 24),
    ignoredColumns: understanding.ignoredColumns.map((entry) => entry.column).slice(0, 24),
  });

const correctionMessages = (
  facts: DatasetFacts,
  base: DatasetConfirmationDraft,
  message: string,
  validationErrors: string[] = [],
): PromptMessage[] => [{
  role: 'system',
  content: [
    THETA_AGENT_MISSION_PROMPT,
    'Interpret one user correction to the corpus understanding used for later text mining, topic-model training, and result analysis.',
    'Return one JSON object only with any corrected fields plus correctionSummary and evidenceSpans.',
    'Use only supplied column names. Never invent, rename, merge, or derive columns.',
    'groupColumns are display/comparison groups; covariateColumns are training covariates; evaluationColumns are evaluation-only labels.',
    'All role fields are arrays of exact column-name strings, never objects.',
    'Required output example: {"domainLabel":"domain","textColumns":["text"],"correctionSummary":"Applied the requested corrections.","evidenceSpans":["正文列是 text"]}.',
    validationErrors.length ? `Repair these errors: ${validationErrors.join(' | ')}` : '',
  ].filter(Boolean).join(' '),
}, {
  role: 'user',
  content: JSON.stringify({
    availableColumns: facts.columns.map((column) => column.name),
    currentUnderstanding: base,
    userCorrection: message,
  }),
}];

const deterministicCorrectionPatch = (
  facts: DatasetFacts,
  message: string,
): z.infer<typeof correctionPatchSchema> => {
  const clauses = message.split(/[；;。，,\n]+/u).map((item) => item.trim()).filter(Boolean);
  const available = facts.columns.map((column) => column.name);
  const exactColumns = (text: string): string[] => available.filter((column) =>
    new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(column)}([^A-Za-z0-9_]|$)`, 'iu').test(text),
  );
  const patch: Record<string, unknown> = {};
  const evidenceSpans: string[] = [];
  for (const clause of clauses) {
    const columns = exactColumns(clause);
    if (/^而是/u.test(clause) || /(?:不是|并非).{0,20}(?:数据|领域).{0,20}(?:而是|是)/u.test(clause) || /(?:属于|方向|领域|主题).{0,5}(?:是|为)/u.test(clause)) {
      const matched = clause.match(/(?:而是|属于|方向(?:是|为)|领域(?:是|为)|主题(?:是|为))\s*([^，,；;。]+)/u);
      if (matched?.[1]?.trim()) patch.domainLabel = matched[1].trim();
    }
    if (/(?:每行|一行|分析单位|每条)/u.test(clause)) {
      const matched = clause.match(/(?:每行(?:代表|是)?|一行(?:代表|是)?|分析单位(?:是|为)?|每条(?:是|代表)?)\s*(.+)$/u);
      if (matched?.[1]?.trim()) patch.analysisUnit = matched[1].trim();
    }
    const assign = (field: string, pattern: RegExp): void => {
      if (pattern.test(clause) && columns.length > 0) patch[field] = columns;
    };
    assign('textColumns', /(?:正文|文本|内容).{0,8}列/u);
    assign('timeColumns', /(?:时间|日期).{0,8}列/u);
    assign('idColumns', /(?:^|[^A-Za-z])(?:ID|id|标识|编号).{0,8}列/u);
    assign('evaluationColumns', /(?:评估|标签|真值).{0,8}列/u);
    if (/(?:展示|比较|分组).{0,20}(?:元数据|列|字段)/u.test(clause)) {
      patch.groupColumns = columns;
      patch.metadataColumns = columns;
    } else {
      assign('groupColumns', /(?:分组|比较).{0,8}(?:列|字段)/u);
      assign('metadataColumns', /(?:元数据|属性).{0,8}(?:列|字段)/u);
    }
    if (/(?:不作为|不要作为|不是).{0,10}(?:训练)?协变量/u.test(clause)) {
      patch.covariateColumns = [];
    } else {
      assign('covariateColumns', /(?:训练)?协变量/u);
    }
    assign('ignoredColumns', /(?:忽略|不用|排除).{0,8}(?:列|字段)/u);
    if (columns.length > 0 || patch.domainLabel || patch.analysisUnit) evidenceSpans.push(clause);
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('无法从修正内容中识别领域、分析单位或现有列角色，请明确指出“正文列是 text”一类信息。');
  }
  return correctionPatchSchema.parse({
    ...patch,
    correctionSummary: '已根据自然语言修正数据理解。',
    evidenceSpans: [...new Set(evidenceSpans)].slice(0, 12),
  });
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
