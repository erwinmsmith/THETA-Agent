import { createHash } from 'node:crypto';
import type {
  InferenceProvider,
  PromptMessage,
} from '@codesoul-co/hypha-inference';
import {
  NATURAL_LANGUAGE_CONTRACT_VERSION,
  naturalLanguageProviderOutputSchema,
  naturalLanguageRequestSchema,
  naturalLanguageResultSchema,
  type NaturalLanguageProviderOutput,
  type NaturalLanguageRequest,
  type NaturalLanguageResult,
} from '@theta-agent/domain/conversation/natural-contracts.js';
import { researchBriefSchema } from '@theta-agent/domain/research/contracts.js';
import {
  sanitizeLanguageText,
  sanitizeResearchBrief,
} from './sanitizer.js';
import { researchAnswerSupportsField } from './research-answer-guards.js';
import { THETA_AGENT_SYSTEM_PROMPT } from './agent-identity.js';

export interface NaturalLanguageServiceOptions {
  provider?: InferenceProvider;
  modelAlias?: string;
}

export class ThetaNaturalLanguageService {
  constructor(private readonly options: NaturalLanguageServiceOptions = {}) {}

  async generate(input: NaturalLanguageRequest): Promise<NaturalLanguageResult> {
    const startedAt = Date.now();
    const request = sanitizeNaturalLanguageRequest(input);
    const factsHash = hash(request);
    if (!this.options.provider) {
      return result(
        request,
        deterministicOutput(request),
        factsHash,
        'deterministic',
        'provider_not_configured',
        {
          providerId: 'deterministic',
          model: null,
          durationMs: Date.now() - startedAt,
          fallback: true,
        },
      );
    }
    try {
      const response = await this.options.provider.infer({
        runId: `theta-conversation-${factsHash.slice(0, 16)}`,
        stepId: request.task,
        modelAlias: this.options.modelAlias ?? 'configured-language-model',
        input: { messages: promptMessages(request) },
        options: {
          temperature: 0.1,
          maxTokens: maxTokensForTask(request.task),
        },
        trace: true,
        metadata: {
          purpose: request.task,
          schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
        },
      });
      const parsedOutput = naturalLanguageProviderOutputSchema.parse(
        sanitizeUnknown(response.output),
      );
      const output = preferSafeDeterministicResolution(request, parsedOutput);
      validateOutput(request, output);
      return result(request, output, factsHash, 'provider', undefined, {
        providerId:
          typeof response.metadata?.providerId === 'string'
            ? response.metadata.providerId
            : this.options.provider.id,
        model:
          typeof response.metadata?.model === 'string'
            ? response.metadata.model
            : (this.options.modelAlias ?? null),
        durationMs: Date.now() - startedAt,
        ...(response.usage?.inputTokens === undefined
          ? {}
          : { inputTokens: response.usage.inputTokens }),
        ...(response.usage?.outputTokens === undefined
          ? {}
          : { outputTokens: response.usage.outputTokens }),
        ...(response.usage?.totalTokens === undefined
          ? {}
          : { totalTokens: response.usage.totalTokens }),
        fallback: false,
      });
    } catch (error) {
      const reason = fallbackReason(error);
      return result(
        request,
        deterministicOutput(request),
        factsHash,
        'deterministic',
        reason,
        {
          providerId: this.options.provider.id,
          model: this.options.modelAlias ?? null,
          durationMs: Date.now() - startedAt,
          fallback: true,
        },
      );
    }
  }
}

const maxTokensForTask = (task: NaturalLanguageRequest['task']): number => {
  switch (task) {
    case 'classify_conversation_intent':
      return 180;
    case 'propose_readonly_tool':
      // Reasoning-capable providers count hidden reasoning tokens against this
      // budget. Leave enough room for the complete validated decision object.
      return 1000;
    case 'generate_grilling_question':
      return 420;
    case 'compose_grounded_response':
      return 800;
    case 'interpret_column_confirmation':
      return 800;
    case 'interpret_research_answer':
      return 1200;
  }
};

const promptMessages = (request: NaturalLanguageRequest): PromptMessage[] => [
  {
    role: 'system',
    content: [
      THETA_AGENT_SYSTEM_PROMPT,
      'Act as the bounded conversational reasoning layer shared by the THETA CLI and Web applications.',
      'Reason semantically about whether the user needs corpus understanding, text mining, data analysis, topic-model selection or training, or interpretation of completed model results.',
      'Return exactly one JSON object and no markdown.',
      'Never change FSM state, approve a plan, approve or start training, execute a tool, invent a dataset column, or include a local path or secret.',
      'Only express information explicitly supported by the user message and supplied facts.',
      'All user-facing wording must be concise Simplified Chinese. Dataset column names and model names may remain unchanged.',
      'Never expose internal field identifiers such as textFieldIntent, analysisUnit, pendingActionRef, or gapId to the user.',
      shape(request),
    ].join(' '),
  },
  { role: 'user', content: JSON.stringify(request) },
];

const shape = (request: NaturalLanguageRequest): string => {
  switch (request.task) {
    case 'interpret_research_answer':
      return [
        `The currently asked field is ${JSON.stringify(request.field.split(',')[0] ?? request.field)}, but extract every ResearchBrief field explicitly supported by this answer in one patch.`,
        researchFieldValueRule(request.field.split(',')[0] ?? request.field),
        'Allowed patch keys are researchQuestion, researchDomain, domainConfirmed, collectionMethod, analysisUnit, timeRange, language, comparisonGroups, comparisonIntent, topicGranularity, knownBiases, sensitiveData, successCriteria, hardwareLimit, textFieldIntent, trendAnalysis, offlineOnly, requestedEmbedding, and timeLimitHours.',
        'Return exactly: {"task":"interpret_research_answer","patch":{"FIELD":VALUE},"answeredFields":["FIELD"],"unresolvedFields":[],"confidenceByField":{"FIELD":0.0},"evidenceSpans":{"FIELD":["exact quote from answer"]},"remainingQuestions":[],"needsConfirmation":false,"explanation":"简短中文说明","questionSuggestions":[{"gapId":"candidate gapId","field":"candidate field","question":"自然的中文追问","examples":[],"answerHint":"如何回答"}]}.',
        'answeredFields, confidenceByField, and evidenceSpans must use exactly the keys present in patch. Every evidence span must be an exact substring of the answer.',
        'For textFieldIntent, a short noun phrase that names the content category, such as 日常词汇、客服对话、新闻正文、商品评论, is a valid answer. Preserve the user wording instead of requiring words such as 正文、字段, or 列.',
        'Reject only content-free acknowledgements or placeholders. When a category phrase is broad but still meaningful, record it and let the FSM ask the next gap instead of repeating the same question.',
        'If the answer cannot resolve the currently asked field, include that field in unresolvedFields and set needsConfirmation to true, but retain other explicitly supported high-confidence fields in patch.',
        'Never infer sensitiveData from silence, politeness, a research objective, or unrelated wording. Only return sensitiveData when the answer explicitly says whether sensitive or confidential data exists.',
        'For each supplied nextGapCandidates item, you may provide one bounded questionSuggestion. Never change its gapId or field. These are candidate phrasings only; the FSM decides which one is actually next.',
      ].join(' ');
    case 'generate_grilling_question':
      return `Shape: {"task":"generate_grilling_question","gapId":${JSON.stringify(request.gapId)},"field":${JSON.stringify(request.field)},"question":"...","reason":"...","examples":[],"answerHint":"..."}.`;
    case 'interpret_column_confirmation':
      return 'Shape: {"task":"interpret_column_confirmation","draft":{"textColumns":[],"timeColumn":null,"idColumn":null,"covariateColumns":[],"metadataColumns":[],"groupingColumns":[],"evaluationLabelColumns":[]},"unknownMentions":[],"ambiguousMentions":[],"confidence":0.0,"needsClarification":false,"explanation":"..."}. The columns command and Web submit button are explicit confirmation, so accept one clear, type-valid assignment without asking the user to repeat it. If the answer is exactly the single supplied text candidate, treat it as the confirmed text column and leave optional roles empty. covariateColumns are training inputs for STM; metadataColumns are descriptive only; groupingColumns are post-hoc display groups; evaluationLabelColumns are held-out labels. Never treat a display group as an STM covariate unless the user explicitly assigns both roles. Omit draft only when a required role is missing or genuinely ambiguous.';
    case 'classify_conversation_intent':
      return [
        'Shape: {"task":"classify_conversation_intent","intent":"read_status|read_evidence|search_evidence|list_models|explain_current|approve_current|reject_current|help|chat|needs_dataset|research_answer|unknown","response":"..."}.',
        'When currentQuestion is supplied, use research_answer only when the user supplies information that answers or corrects that question.',
        'Short category phrases may be complete research answers when the currentQuestion asks for a category, content type, comparison group, language, granularity, or other bounded value.',
        'Questions about THETA capabilities, models, data handling, the current workflow, or how to answer are assistant requests, not research_answer.',
        'A short uncertainty answer such as 不知道 or 不确定 is still research_answer when it responds to currentQuestion.',
      ].join(' ');
    case 'propose_readonly_tool':
      return [
        'Shape: {"task":"propose_readonly_tool","intent":"read_status|read_evidence|search_evidence|list_models|explain_current|approve_current|reject_current|help|chat|needs_dataset|research_answer|unknown","toolId":"one supplied allowedToolIds or null","arguments":{},"reason":"...","confidence":0.0,"requiresConfirmation":false}.',
        'Select a Tool by semantic reasoning over the complete request and current FSM state, never by keyword or substring matching.',
        'Use intent needs_dataset when the user wants analysis of their own data but no active dataset context exists. Do not use it for questions about capabilities, setup, examples, models, or how the system works.',
        'Use only a supplied allowedToolId, and return toolId null when the allowlist is empty, the request can be answered from supplied context, or confidence is below 0.75.',
        'toolHistory contains read-only tools already completed for this turn. Do not repeat them. Select another tool only when its result is necessary to resolve a remaining part of the request.',
        'When the request asks for concrete model availability, use theta.model.catalog. When it asks for THETA facts, documentation, or research guidance that is not already supplied, use theta.rag.search. For a request with multiple unresolved parts, choose the most useful remaining tool now; a later decision will evaluate whether another tool is needed.',
        'For theta.rag.search include a concise semantic search query in arguments.query. Never propose a write, approval, or training Tool.',
      ].join(' ');
    case 'compose_grounded_response':
      return 'Shape: {"task":"compose_grounded_response","text":"...","evidenceIds":[]}. Answer as THETA Agent about text datasets, corpus diagnostics, text mining, topic-model design and training, the active workflow, evidence, trained topics, metrics, visualizations, limitations, and safe next steps. Use only supplied facts and evidence; distinguish proposed work from completed execution and never claim an action was executed unless facts prove it. Only repeat a pending research question when facts.currentQuestion is a non-empty string and it still needs an answer; never repeat userText as a pending question after answering it.';
  }
};

const validateOutput = (
  request: NaturalLanguageRequest,
  output: NaturalLanguageProviderOutput,
): void => {
  if (request.task !== output.task) {
    throw new Error('Provider changed the requested task.');
  }
  if (
    request.task === 'interpret_research_answer' &&
    output.task === 'interpret_research_answer'
  ) {
    const patchedFields = new Set(Object.keys(output.patch));
    const answeredFields = new Set(output.answeredFields);
    const confidenceFields = new Set(Object.keys(output.confidenceByField));
    const evidenceFields = new Set(Object.keys(output.evidenceSpans));
    if (
      !sameSet(patchedFields, answeredFields) ||
      !sameSet(patchedFields, confidenceFields) ||
      !sameSet(patchedFields, evidenceFields) ||
      (patchedFields.size === 0 &&
        !output.needsConfirmation &&
        output.unresolvedFields.length === 0)
    ) {
      throw new Error(
        'Provider answer metadata is inconsistent with its ResearchBriefPatch.',
      );
    }
    if (
      Object.values(output.evidenceSpans)
        .flat()
        .some((span) => !request.answer.includes(span))
    ) {
      throw new Error('Provider research evidence is not an exact answer span.');
    }
    const allowedSuggestions = new Map(
      (request.nextGapCandidates ?? []).map((candidate) => [
        candidate.gapId,
        candidate.field,
      ]),
    );
    if (
      output.questionSuggestions.some(
        (suggestion) =>
          allowedSuggestions.get(suggestion.gapId) !== suggestion.field ||
          !/[\u3400-\u9fff]/u.test(suggestion.question),
      )
    ) {
      throw new Error(
        'Provider question suggestion changed an authoritative gap or failed the Chinese UX quality gate.',
      );
    }
  }
  if (
    request.task === 'generate_grilling_question' &&
    output.task === 'generate_grilling_question'
  ) {
    if (output.gapId !== request.gapId || output.field !== request.field) {
      throw new Error('Provider changed the authoritative gap or field.');
    }
    if (
      !/[\u3400-\u9fff]/u.test(output.question) ||
      /(textFieldIntent|analysisUnit|pendingActionRef|gapId|ResearchBrief)/u.test(
        `${output.question} ${output.answerHint ?? ''}`,
      )
    ) {
      throw new Error('Provider question failed the Chinese UX quality gate.');
    }
  }
  if (
    request.task === 'interpret_column_confirmation' &&
    output.task === 'interpret_column_confirmation' &&
    output.draft
  ) {
    const allowed = new Set(request.columns);
    const selected = [
      ...output.draft.textColumns,
      ...(output.draft.timeColumn ? [output.draft.timeColumn] : []),
      ...(output.draft.idColumn ? [output.draft.idColumn] : []),
      ...(output.draft.covariateColumns ?? []),
      ...output.draft.metadataColumns,
      ...(output.draft.groupingColumns ?? []),
      ...(output.draft.evaluationLabelColumns ?? []),
    ];
    if (selected.some((column) => !allowed.has(column))) {
      throw new Error('Provider invented a dataset column.');
    }
    const roleIssue = validateColumnRoleDraft(
      { ...output.draft, covariateColumns: output.draft.covariateColumns ?? [] },
      request.columnProfiles ?? [],
    );
    if (roleIssue) throw new Error(roleIssue);
  }
  if (
    request.task === 'propose_readonly_tool' &&
    output.task === 'propose_readonly_tool' &&
    output.toolId !== null &&
    !request.allowedToolIds.includes(output.toolId)
  ) {
    throw new Error('Provider proposed a tool outside the state allowlist.');
  }
};

const deterministicOutput = (
  request: NaturalLanguageRequest,
): NaturalLanguageProviderOutput => {
  switch (request.task) {
    case 'interpret_research_answer':
      return deterministicResearchAnswer(request);
    case 'generate_grilling_question':
      return {
        task: request.task,
        gapId: request.gapId,
        field: request.field,
        question: normalizeQuestion(request.draftQuestion),
        reason: request.reason,
        examples: deterministicExamples(request.field),
        answerHint:
          request.attempt === 1
            ? '请直接用自然语言回答；如果不确定，也可以说明“不知道”。'
            : '如果这个问题不适用于你的研究，可以回答“不适用”。',
      };
    case 'interpret_column_confirmation':
      return deterministicColumns(request);
    case 'classify_conversation_intent':
      return deterministicIntent(request.text, request.currentQuestion);
    case 'propose_readonly_tool':
      return deterministicToolProposal(request.text, request.allowedToolIds);
    case 'compose_grounded_response':
      return {
        task: request.task,
        text: deterministicGroundedResponse(request),
        evidenceIds: request.evidence.map((item) => item.evidenceId),
      };
  }
};

const deterministicResearchAnswer = (
  request: Extract<
    NaturalLanguageRequest,
    { task: 'interpret_research_answer' }
  >,
): NaturalLanguageProviderOutput => {
  const answer = request.answer.trim();
  const field = request.field.split(',')[0] ?? request.field;
  const patch = deterministicResearchPatch(answer, field);
  const evidenceSpans: Record<string, string[]> = Object.fromEntries(
    Object.keys(patch).map((name) => [name, [evidenceForField(answer, name)]]),
  );
  const answered = Object.keys(patch);
  const resolvedActiveField = answered.includes(field);
  return {
    task: request.task,
    patch,
    answeredFields: answered,
    unresolvedFields: resolvedActiveField ? [] : [field],
    confidenceByField: Object.fromEntries(
      answered.map((name) => [name, name === field ? 0.72 : 0.84]),
    ),
    evidenceSpans,
    remainingQuestions: resolvedActiveField ? [] : [request.question],
    needsConfirmation: !resolvedActiveField,
    explanation:
      answered.length === 0
        ? '确定性回退无法安全映射这段回答，需要进一步确认。'
        : `已从本轮回答中识别 ${answered.length} 项研究信息。`,
    questionSuggestions: (request.nextGapCandidates ?? []).map((candidate) => ({
      gapId: candidate.gapId,
      field: candidate.field,
      question: normalizeQuestion(candidate.draftQuestion),
      examples: deterministicExamples(candidate.field),
      answerHint: '请直接用自然语言回答；如果不确定，也可以说明“不知道”。',
    })),
  };
};

const preferDeterministicColumnConfirmation = (
  request: NaturalLanguageRequest,
  output: NaturalLanguageProviderOutput,
): NaturalLanguageProviderOutput => {
  if (
    request.task !== 'interpret_column_confirmation' ||
    output.task !== 'interpret_column_confirmation' ||
    !output.needsClarification
  ) {
    return output;
  }
  const deterministic = deterministicColumns(request);
  return deterministic.task === 'interpret_column_confirmation' &&
    !deterministic.needsClarification
    ? deterministic
    : output;
};

const preferSafeDeterministicResolution = (
  request: NaturalLanguageRequest,
  output: NaturalLanguageProviderOutput,
): NaturalLanguageProviderOutput =>
  preferDeterministicColumnConfirmation(
    request,
    preferDeterministicResearchResolution(request, output),
  );

const preferDeterministicResearchResolution = (
  request: NaturalLanguageRequest,
  output: NaturalLanguageProviderOutput,
): NaturalLanguageProviderOutput => {
  if (
    request.task !== 'interpret_research_answer' ||
    output.task !== 'interpret_research_answer'
  ) {
    return output;
  }
  const activeField = request.field.split(',')[0] ?? request.field;
  if (Object.prototype.hasOwnProperty.call(output.patch, activeField)) {
    return output;
  }
  const deterministic = deterministicResearchAnswer(request);
  if (
    deterministic.task !== 'interpret_research_answer' ||
    !Object.prototype.hasOwnProperty.call(deterministic.patch, activeField)
  ) {
    return output;
  }
  const answeredFields = Array.from(
    new Set([...output.answeredFields, ...deterministic.answeredFields]),
  );
  const unresolvedFields = output.unresolvedFields.filter(
    (field) => field !== activeField,
  );
  return {
    ...output,
    patch: { ...output.patch, ...deterministic.patch },
    answeredFields,
    unresolvedFields,
    confidenceByField: {
      ...output.confidenceByField,
      ...deterministic.confidenceByField,
    },
    evidenceSpans: {
      ...output.evidenceSpans,
      ...deterministic.evidenceSpans,
    },
    remainingQuestions:
      unresolvedFields.length === 0 ? [] : output.remainingQuestions,
    needsConfirmation: unresolvedFields.length > 0,
  };
};

const deterministicResearchPatch = (
  answer: string,
  field: string,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  const supportsActiveField = researchAnswerSupportsField(field, answer);
  if (field === 'domainConfirmed' && supportsActiveField) {
    const correction = answer.match(/(?:不是|不对|更准确|应该是|属于)\s*[“"']?([^，。；;！!？?]{2,40})/u)?.[1]?.trim();
    patch.domainConfirmed = true;
    if (correction && !/^(?:这个|该|上述|系统判断)$/u.test(correction)) {
      patch.researchDomain = correction;
    }
  } else if (field === 'trendAnalysis' && supportsActiveField) {
    if (/(时间|趋势|变化|temporal|trend)/iu.test(answer)) {
      patch.trendAnalysis = !/(不|否|no|不要|无需)/iu.test(answer);
    }
  } else if (field === 'offlineOnly' && supportsActiveField) {
    patch.offlineOnly = !/(联网|远程|online|remote)/iu.test(answer);
  } else if (field === 'topicGranularity' && supportsActiveField) {
    patch.topicGranularity = /细|fine/iu.test(answer)
      ? 'fine'
      : /粗|宽|broad/iu.test(answer)
        ? 'broad'
        : 'medium';
  } else if (field === 'timeRange' && supportsActiveField) {
    const years = answer.match(/(?:19|20)\d{2}/gu) ?? [];
    if (years.length > 0) {
      patch.timeRange = {
        start: years[0],
        ...(years[1] ? { end: years[1] } : {}),
      };
    }
  } else if (field === 'sensitiveData' && supportsActiveField) {
    const sensitiveStatus = explicitSensitiveStatus(answer, true);
    if (sensitiveStatus) {
      patch.sensitiveData = { status: sensitiveStatus, categories: [] };
    }
  } else if (field === 'hardwareLimit' && supportsActiveField) {
    const memory = answer.match(/(\d+(?:\.\d+)?)\s*(?:GB|G)/iu);
    patch.hardwareLimit = {
      device:
        /(?:不|不要|不用|禁止|无法|没有|无)\s*(?:使用|可用|支持)?\s*(?:GPU|显卡|CUDA)/iu.test(
          answer,
        )
          ? 'cpu'
          : /GPU|显卡|CUDA/iu.test(answer)
            ? 'gpu'
            : /CPU/iu.test(answer)
              ? 'cpu'
              : 'unknown',
      ...(memory ? { memoryGb: Number(memory[1]) } : {}),
    };
  } else if (
    supportsActiveField &&
    ['comparisonGroups', 'knownBiases', 'successCriteria'].includes(field)
  ) {
    patch[field] = answer
      .split(/[，,、;；]/u)
      .map((value) => value.trim())
      .filter(Boolean);
  } else if (
    supportsActiveField &&
    [
      'researchQuestion',
      'researchDomain',
      'collectionMethod',
      'analysisUnit',
      'language',
      'textFieldIntent',
    ].includes(field)
  ) {
    patch[field] = answer;
  }

  const researchQuestion = clauseMatching(
    answer,
    /(?:研究问题|研究目标|分析目标)\s*(?:是|为|：|:)|(?:我希望|希望)\s*(?:识别|分析|比较|探索|研究)/iu,
  );
  if (researchQuestion) patch.researchQuestion = researchQuestion;

  const analysisUnit = clauseMatching(
    answer,
    /(?:每一|每)\s*(?:行|条|篇|个).{0,16}(?:代表|作为|是)|分析单位\s*(?:是|为|：|:)/iu,
  );
  if (analysisUnit) patch.analysisUnit = analysisUnit;

  const textIntent = clauseMatching(
    answer,
    /(?:正文|文本内容|自然语言内容|待分析文本)\s*(?:列|是|为|：|:|用于)/iu,
  );
  if (textIntent) patch.textFieldIntent = textIntent;

  const sensitiveStatus = explicitSensitiveStatus(answer);
  if (sensitiveStatus) {
    patch.sensitiveData = { status: sensitiveStatus, categories: [] };
  }

  if (/(?:CPU|GPU|显卡|CUDA|\d+(?:\.\d+)?\s*(?:GB|G)\b)/iu.test(answer)) {
    const memory = answer.match(/(\d+(?:\.\d+)?)\s*(?:GB|G)\b/iu);
    patch.hardwareLimit = {
      device: /(?:不|不要|不用|禁止|无法|没有|无)\s*(?:使用|可用|支持)?\s*(?:GPU|显卡|CUDA)/iu.test(answer)
        ? 'cpu'
        : /(?:GPU|显卡|CUDA)/iu.test(answer)
          ? 'gpu'
          : /CPU/iu.test(answer)
            ? 'cpu'
            : 'unknown',
      ...(memory ? { memoryGb: Number(memory[1]) } : {}),
    };
  }

  const success = clauseMatching(answer, /(?:成功标准|验收标准|结果需要|希望结果)\s*(?:是|为|包括|：|:)?/iu);
  if (success) patch.successCriteria = [success];

  const biases = clauseMatching(answer, /(?:偏差|局限|限制)\s*(?:是|为|包括|：|:)?/iu);
  if (biases) patch.knownBiases = [biases];

  if (/(?:离线|不联网|无需联网|offline)/iu.test(answer)) patch.offlineOnly = true;
  if (/(?:时间|日期).{0,12}(?:趋势|变化)|(?:趋势|变化).{0,12}(?:时间|日期)/iu.test(answer)) {
    patch.trendAnalysis = true;
  }
  return patch;
};

const explicitSensitiveStatus = (
  answer: string,
  allowShortAnswer = false,
): 'yes' | 'no' | undefined => {
  const shortNo =
    allowShortAnswer && /^(?:否|no|不包含|不含|没有|无|不存在)[。.]?$/iu.test(answer.trim());
  const shortYes =
    allowShortAnswer && /^(?:是|有|包含|yes)[。.]?$/iu.test(answer.trim());
  const explicitNo =
    shortNo ||
    /(?:不包含|不含|不存在|没有|无).{0,16}(?:个人|隐私|机密|敏感|医疗|商业)(?:信息|内容|数据)?|(?:个人|隐私|机密|敏感|医疗|商业)(?:信息|内容|数据)?.{0,16}(?:不包含|不含|不存在|没有|无)|无敏感|非敏感|合成数据|模拟数据/iu.test(answer);
  if (explicitNo) return 'no';
  return shortYes ||
    /(包含|含有|存在|涉及).{0,12}(个人|隐私|机密|敏感|医疗|商业)|\byes\b.{0,12}(sensitive|personal|confidential)/iu.test(answer)
    ? 'yes'
    : undefined;
};

const clauseMatching = (answer: string, pattern: RegExp): string | undefined =>
  answer
    .split(/[。！？!?；;\n]/u)
    .map((value) => value.trim())
    .find((value) => pattern.test(value));

const evidenceForField = (answer: string, field: string): string =>
  clauseMatching(answer, fieldEvidencePattern(field)) ?? answer;

const fieldEvidencePattern = (field: string): RegExp =>
  ({
    researchQuestion: /研究|目标|识别|分析|比较|探索/iu,
    researchDomain: /领域|方向|法律|教育|医疗|金融|科技|新闻|商品|文学|生活/iu,
    domainConfirmed: /是|准确|符合|不对|不是|领域|方向/iu,
    analysisUnit: /每一|每行|每条|每篇|分析单位/iu,
    textFieldIntent: /正文|文本内容|自然语言内容/iu,
    sensitiveData: /个人|隐私|机密|敏感|合成|模拟/iu,
    hardwareLimit: /CPU|GPU|显卡|CUDA|GB/iu,
    successCriteria: /成功|验收|结果/iu,
    knownBiases: /偏差|局限|限制/iu,
    trendAnalysis: /时间|趋势|变化/iu,
    offlineOnly: /离线|联网|offline/iu,
  } as Readonly<Record<string, RegExp>>)[field] ?? /[\s\S]+/u;

const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

const deterministicExamples = (field: string): string[] => {
  const examples: Readonly<Record<string, string>> = {
    researchQuestion: '我想比较不同来源的风险主题，并观察它们随时间的变化。',
    domainConfirmed: '是，这个领域判断准确。',
    analysisUnit: '每一行是一条独立文档，正文位于 text 列。',
    textFieldIntent: '分析 text 列中的正文，不分析编号和时间。',
    sensitiveData: '这是人工模拟数据，不包含个人或机密信息。',
    collectionMethod: '数据由人工模拟生成，用于验证主题分析流程。',
    comparisonGroups: '比较不同 source，并按月份观察变化。',
    successCriteria: '主题应当清晰可解释，并能展示来源之间的差异。',
    topicGranularity: '先使用少量宽泛主题，保证结果稳定。',
    knownBiases: '样本量较小，不能代表真实总体。',
    hardwareLimit: '只使用 CPU，内存约 16GB。',
  };
  return examples[field] ? [examples[field]] : [];
};

const deterministicColumns = (
  request: Extract<
    NaturalLanguageRequest,
    { task: 'interpret_column_confirmation' }
  >,
): NaturalLanguageProviderOutput => {
  const mentioned = request.columns.filter((column) =>
    request.answer.toLowerCase().includes(column.toLowerCase()),
  );
  const linked = (column: string, labels: string): boolean => {
    const columnName = column.toLowerCase();
    const roleLabels = labels.split('|').map((label) => label.toLowerCase());
    return request.answer
      .toLowerCase()
      .split(/[，,；;。\n]/u)
      .some(
        (clause) =>
          clause.includes(columnName) &&
          roleLabels.some((label) => clause.includes(label)),
      );
  };
  const uniqueTextCandidate = request.candidates.text.length === 1
    ? request.candidates.text[0]
    : undefined;
  const shorthandText =
    mentioned.length === 1 &&
    uniqueTextCandidate &&
    mentioned[0]?.toLowerCase() === uniqueTextCandidate.toLowerCase()
      ? uniqueTextCandidate
      : undefined;
  const text =
    mentioned.find((column) => linked(column, '正文|文本内容|待分析文本|语料')) ??
    shorthandText;
  const time = mentioned.find((column) => linked(column, '时间列|日期列|时间戳')) ?? null;
  const id = mentioned.find((column) => linked(column, 'ID列|ID 列|标识列|标识 列|编号列|编号 列|唯一标识')) ?? null;
  const covariates = mentioned.filter((column) =>
    linked(column, '训练协变量|协变量列|STM协变量|模型协变量'),
  );
  const groups = mentioned.filter((column) =>
    linked(column, '展示分组|分组列|对比分组|分组展示|分组元数据'),
  );
  const labels = mentioned.filter((column) =>
    linked(column, '评估标签|标签列|Golden标签|真值标签'),
  );
  const reserved = new Set([
    ...(text ? [text] : []),
    ...(time ? [time] : []),
    ...(id ? [id] : []),
    ...covariates,
    ...groups,
    ...labels,
  ]);
  const metadata = mentioned.filter(
    (column) =>
      !reserved.has(column) &&
      linked(column, '描述元数据|元数据列|辅助信息'),
  );
  if (!text) {
    return {
      task: request.task,
      unknownMentions: [],
      ambiguousMentions: mentioned,
      confidence: 0,
      needsClarification: true,
      explanation: '无法确定唯一文本列，请明确说明正文列名称。',
    };
  }
  const draft = {
    textColumns: [text],
    timeColumn: time,
    idColumn: id,
    covariateColumns: covariates,
    metadataColumns: metadata,
    groupingColumns: groups,
    evaluationLabelColumns: labels,
  };
  const roleIssue = validateColumnRoleDraft(draft, request.columnProfiles ?? []);
  if (roleIssue) {
    return {
      task: request.task,
      draft,
      unknownMentions: [],
      ambiguousMentions: mentioned,
      confidence: 0,
      needsClarification: true,
      explanation: `${roleIssue} 请重新明确各列角色。`,
    };
  }
  return {
    task: request.task,
    draft,
    unknownMentions: [],
    ambiguousMentions: [],
    confidence: 0.9,
    needsClarification: false,
    explanation: `已通过列类型校验：${columnDraftSummary(draft)}。`,
  };
};

type ColumnRoleDraft = {
  textColumns: string[];
  timeColumn: string | null;
  idColumn: string | null;
  covariateColumns: string[];
  metadataColumns: string[];
  groupingColumns?: string[];
  evaluationLabelColumns?: string[];
};

const validateColumnRoleDraft = (
  draft: ColumnRoleDraft,
  profiles: ReadonlyArray<{
    name: string;
    inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
    nonEmptySampleCount: number;
    uniqueSampleCount: number;
    avgLength: number;
    maxLength: number;
  }>,
): string | undefined => {
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const profile = (name: string) => byName.get(name);
  const idLike = (name: string) => /(?:^|_)(?:id|uuid|key|index|record_id)(?:$|_)/iu.test(name);
  for (const column of draft.textColumns) {
    const item = profile(column);
    if (idLike(column) || item?.inferredType === 'number' || item?.inferredType === 'datetime' || item?.inferredType === 'empty') {
      return `列 ${column} 的类型不适合作为正文`;
    }
    if (item && item.avgLength < 8 && item.inferredType !== 'text') {
      return `列 ${column} 的样本文本过短，不足以安全认定为正文`;
    }
  }
  if (draft.timeColumn) {
    const item = profile(draft.timeColumn);
    if (item && item.inferredType !== 'datetime') return `列 ${draft.timeColumn} 不能稳定解析为时间`;
  }
  if (draft.idColumn) {
    const item = profile(draft.idColumn);
    const uniqueRatio = item && item.nonEmptySampleCount > 0
      ? item.uniqueSampleCount / item.nonEmptySampleCount
      : 0;
    if (!idLike(draft.idColumn) && item && uniqueRatio < 0.8) {
      return `列 ${draft.idColumn} 不具备唯一标识特征`;
    }
  }
  const roles = [
    ...draft.textColumns.map((name) => [name, '正文'] as const),
    ...(draft.timeColumn ? [[draft.timeColumn, '时间'] as const] : []),
    ...(draft.idColumn ? [[draft.idColumn, 'ID'] as const] : []),
    ...draft.covariateColumns.map((name) => [name, '训练协变量'] as const),
    ...draft.metadataColumns.map((name) => [name, '描述元数据'] as const),
    ...(draft.groupingColumns ?? []).map((name) => [name, '展示分组'] as const),
    ...(draft.evaluationLabelColumns ?? []).map((name) => [name, '评估标签'] as const),
  ];
  const assigned = new Map<string, string[]>();
  for (const [name, role] of roles) assigned.set(name, [...(assigned.get(name) ?? []), role]);
  const overlap = [...assigned].find(([, values]) => {
    const roles = new Set(values);
    return values.length > 1 && !(
      roles.size === 2 &&
      roles.has('训练协变量') &&
      roles.has('展示分组')
    );
  });
  if (overlap) return `列 ${overlap[0]} 同时被绑定为 ${overlap[1].join('、')}`;
  for (const column of [...draft.covariateColumns, ...(draft.groupingColumns ?? [])]) {
    const item = profile(column);
    const uniqueRatio = item && item.nonEmptySampleCount > 0
      ? item.uniqueSampleCount / item.nonEmptySampleCount
      : 0;
    if (item && (item.inferredType === 'text' || uniqueRatio > 0.8)) {
      return `列 ${column} 不适合作为低基数协变量或展示分组`;
    }
  }
  return undefined;
};

const columnDraftSummary = (draft: ColumnRoleDraft): string =>
  `正文 ${draft.textColumns.join('、')}；时间 ${draft.timeColumn ?? '无'}；ID ${draft.idColumn ?? '无'}；训练协变量 ${draft.covariateColumns.join('、') || '无'}；展示分组 ${(draft.groupingColumns ?? []).join('、') || '无'}`;

const deterministicIntent = (
  text: string,
  currentQuestion?: string,
): NaturalLanguageProviderOutput => {
  const normalized = text.toLowerCase();
  const intent = /状态|进度|status|progress/u.test(normalized)
    ? 'read_status'
    : /证据|依据|evidence/u.test(normalized)
      ? 'read_evidence'
      : /搜索|检索|search/u.test(normalized)
        ? 'search_evidence'
        : /模型|models?/u.test(normalized)
          ? 'list_models'
          : /为什么|解释|why|explain/u.test(normalized)
            ? 'explain_current'
            : /同意|批准|approve/u.test(normalized)
              ? 'approve_current'
              : /拒绝|不同意|reject/u.test(normalized)
                ? 'reject_current'
                : /帮助|help|怎么用|能做什么|可以做什么|你是谁/u.test(normalized)
                  ? 'help'
                  : currentQuestion && !/[？?]$/u.test(normalized)
                    ? 'research_answer'
                    : 'chat';
  return {
    task: 'classify_conversation_intent',
    intent,
    response: `已识别为 ${intent}。`,
  };
};

const deterministicGroundedResponse = (
  request: Extract<
    NaturalLanguageRequest,
    { task: 'compose_grounded_response' }
  >,
): string => {
  if (request.evidence.length > 0) {
    return `根据 THETA 本地知识与运行证据，已找到 ${request.evidence.length} 条相关信息：${request.evidence.map((item) => item.excerpt).join('；')}`;
  }
  const facts = request.facts as Record<string, unknown>;
  const capabilities = Array.isArray(facts.capabilities)
    ? facts.capabilities.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const currentQuestion =
    typeof facts.currentQuestion === 'string'
      ? facts.currentQuestion
      : undefined;
  if (typeof facts.inferenceIssue === 'string') {
    return '当前语言模型供应商不可用，Agent 无法完成语义意图判断，因此没有擅自调出上传卡片或执行工具。请在设置中检查模型、API Key 与账户额度后重试。';
  }
  if (capabilities.length > 0) {
    return [
      `我是专注主题建模、文本挖掘与数据分析的 THETA Agent。我可以${capabilities.join('；')}。`,
      typeof facts.boundary === 'string' ? facts.boundary : '',
      currentQuestion ? `当前研究流程仍需确认：${currentQuestion}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return `根据当前 THETA 受治理工具结果：${sanitizeLanguageText(JSON.stringify(request.facts), 1600)}`;
};

const deterministicToolProposal = (
  text: string,
  allowed: readonly string[],
): NaturalLanguageProviderOutput => {
  void text;
  void allowed;
  return {
    task: 'propose_readonly_tool',
    intent: 'unknown',
    toolId: null,
    arguments: {},
    reason: '模型推理不可用，因此不会基于本地关键词猜测并执行工具。',
    confidence: 0,
    requiresConfirmation: false,
  };
};

const result = (
  request: NaturalLanguageRequest,
  output: NaturalLanguageProviderOutput,
  factsHash: string,
  source: 'provider' | 'deterministic',
  fallbackReason?: string,
  telemetry: {
    providerId: string;
    model: string | null;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    fallback: boolean;
  } = {
    providerId: source,
    model: null,
    durationMs: 0,
    fallback: Boolean(fallbackReason),
  },
): NaturalLanguageResult =>
  naturalLanguageResultSchema.parse({
    schemaVersion: NATURAL_LANGUAGE_CONTRACT_VERSION,
    source,
    ...(fallbackReason ? { fallbackReason } : {}),
    factsHash,
    telemetry,
    output,
  });

export const sanitizeNaturalLanguageRequest = (
  input: NaturalLanguageRequest,
): NaturalLanguageRequest => {
  const parsed = naturalLanguageRequestSchema.parse(input);
  const cleanMessages = 'recentMessages' in parsed
    ? parsed.recentMessages.map((message) => ({
        ...message,
        content: sanitizeLanguageText(message.content, 2000),
      }))
    : undefined;
  if (parsed.task === 'interpret_research_answer') {
    return {
      ...parsed,
      answer: sanitizeLanguageText(parsed.answer, 2000),
      question: sanitizeLanguageText(parsed.question, 2000),
      currentBrief: sanitizeBriefRecord(parsed.currentBrief),
      recentMessages: cleanMessages ?? [],
    };
  }
  if (parsed.task === 'generate_grilling_question') {
    return {
      ...parsed,
      reason: sanitizeLanguageText(parsed.reason, 2000),
      draftQuestion: sanitizeLanguageText(parsed.draftQuestion, 2000),
      currentBrief: sanitizeBriefRecord(parsed.currentBrief),
      recentMessages: cleanMessages ?? [],
    };
  }
  if (parsed.task === 'interpret_column_confirmation') {
    return {
      ...parsed,
      answer: sanitizeLanguageText(parsed.answer, 2000),
      recentMessages: cleanMessages ?? [],
    };
  }
  if (parsed.task === 'compose_grounded_response') {
    return {
      ...parsed,
      userText: sanitizeLanguageText(parsed.userText, 2000),
      facts: sanitizeUnknownRecord(parsed.facts),
      evidence: parsed.evidence.map((item) => ({
        evidenceId: sanitizeLanguageText(item.evidenceId, 160),
        excerpt: sanitizeLanguageText(item.excerpt, 1200),
      })),
      recentMessages: cleanMessages ?? [],
    };
  }
  return { ...parsed, text: sanitizeLanguageText(parsed.text, 2000) };
};

const sanitizeBriefRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const brief = researchBriefSchema.safeParse(value);
  return brief.success
    ? sanitizeResearchBrief(brief.data)
    : sanitizeUnknownRecord(value);
};

const sanitizeUnknownRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .map(([key, nested]) => [
        sanitizeLanguageText(key, 120),
        sanitizeUnknown(nested),
      ]),
  );

const sanitizeUnknown = (value: unknown): unknown => {
  if (typeof value === 'string') return sanitizeLanguageText(value, 1200);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeUnknown);
  if (value && typeof value === 'object') {
    return sanitizeUnknownRecord(value as Record<string, unknown>);
  }
  return undefined;
};

const normalizeQuestion = (value: string): string =>
  `${value.trim().replace(/[。.!！?？]+$/u, '')}？`;

const escape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(sortValue(value)))
    .digest('hex');

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
};

const fallbackReason = (error: unknown): string => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return String((error as { code: string }).code);
  }
  if (error instanceof Error) {
    if (error.name === 'ZodError') return 'schema_validation_error';
    if (/metadata is inconsistent/iu.test(error.message)) {
      return 'answer_metadata_inconsistent';
    }
    if (/question failed the Chinese UX quality gate/iu.test(error.message)) {
      return 'question_quality_rejected';
    }
    if (/changed the authoritative gap or field/iu.test(error.message)) {
      return 'question_authority_violation';
    }
    if (/changed the requested task/iu.test(error.message)) {
      return 'task_mismatch';
    }
  }
  return 'schema_or_provider_error';
};

const researchFieldValueRule = (field: string): string => {
  const rules: Readonly<Record<string, string>> = {
    researchQuestion: 'VALUE must be a non-empty string.',
    researchDomain: 'VALUE must be a non-empty string.',
    domainConfirmed: 'VALUE must be a boolean.',
    collectionMethod: 'VALUE must be a non-empty string.',
    analysisUnit: 'VALUE must be a non-empty string.',
    language: 'VALUE must be a non-empty string.',
    textFieldIntent: 'VALUE must be a non-empty string.',
    comparisonGroups: 'VALUE must be an array of non-empty strings.',
    comparisonIntent: 'VALUE must be exactly "unknown", "none", or "groups".',
    knownBiases: 'VALUE must be an array of non-empty strings.',
    successCriteria: 'VALUE must be an array of non-empty strings.',
    topicGranularity:
      'VALUE must be exactly "broad", "medium", or "fine".',
    sensitiveData:
      'VALUE must be {"status":"yes"|"no"|"unknown","categories":[]} with categories as an array of strings.',
    hardwareLimit:
      'VALUE must be {"device":"cpu"|"gpu"|"unknown"} and may include a positive numeric memoryGb.',
    trendAnalysis: 'VALUE must be a boolean.',
    offlineOnly: 'VALUE must be a boolean.',
    requestedEmbedding:
      'VALUE must be exactly "local", "remote", "none", or "unknown".',
    timeRange:
      'VALUE must be an object with optional non-empty string start and end.',
    timeLimitHours: 'VALUE must be a positive number.',
  };
  return rules[field] ?? 'VALUE must follow the supplied ResearchBrief field type.';
};
