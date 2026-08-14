import type {
  HumanFacingResponse,
  HumanSection,
} from './contracts.js';
import { resolveNextActions } from './next-action-resolver.js';
import {
  stateLabel,
  WORKFLOW_TOTAL_STEPS,
} from './state-labels.zh-CN.js';

export const buildHumanResponse = (value: unknown): HumanFacingResponse => {
  const record = asRecord(value);
  if (!record) {
    return response('message', 'THETA', human(value), undefined, value);
  }

  const kind = text(record.kind) ?? 'workflow';
  if (kind.startsWith('inference.')) return inferenceSelection(record, value);
  if (kind === 'language.consent') return languageConsent(record, value);
  if (kind === 'run.required') return runRequired(record, value);
  if (kind === 'research.brief') return researchBrief(record, value);
  if (kind === 'conversation.history') return history(record, value);
  if (kind === 'run.explanation') return runExplanation(record, value);
  if (kind === 'plan.review' || hasPlan(record)) return plan(record, value);
  if (kind.startsWith('research.answer')) return researchAnswer(record, value);
  if (kind.startsWith('columns.')) return columns(record, value);
  if (kind === 'plan.adjusted') {
    const workflowRecord = asRecord(record.workflow);
    return {
      kind,
      title: '训练方案已调整',
      summary:
        text(record.response) ??
        '修改已经应用，系统已重新验证候选训练方案。',
      sections: [
        {
          title: '修改内容',
          lines: Object.entries(asRecord(record.adjustment) ?? {}).map(
            ([key, item]) => `${fieldLabel(key)}：${human(item)}`,
          ),
        },
      ],
      nextActions: resolveNextActions(
        workflowRecord?.currentState ?? 'AwaitPlanCreationApproval',
        workflowRecord?.status,
      ),
      technicalDetails: value,
    };
  }
  if (kind === 'conversation.turn') return conversation(record, value);
  if (kind === 'run.results' || kind === 'run.summary') {
    return runResults(record, value, kind === 'run.summary');
  }
  if (kind === 'training.logs') return trainingLogs(record, value);
  if (kind === 'training.quality.reassessed') {
    const quality = asRecord(record.quality);
    return {
      kind,
      title: '质量门已重新评估',
      summary: text(record.response) ?? '已按当前落盘产物重新计算质量门。',
      sections: [{
        title: '评估结果',
        lines: [
          `训练 ID：${human(record.trainingRunId)}`,
          `质量状态：${human(quality?.status ?? 'unknown')}`,
          `检查项：${Array.isArray(quality?.checks) ? quality.checks.length : 0} 项`,
        ],
      }],
      nextActions: record.runId
        ? resolveNextActions('Completed')
        : resolveNextActions(undefined),
      technicalDetails: value,
    };
  }
  if (kind === 'run.catalog') return runCatalog(record, value);
  if (kind.startsWith('training.cancel')) {
    return response(
      kind,
      kind === 'training.cancel.review' ? '取消训练确认' : '训练取消已处理',
      text(record.response) ?? '取消请求已处理。',
      undefined,
      value,
    );
  }
  if (kind === 'replay.fixture') {
    return response(
      kind,
      'Replay 已生成',
      '已根据持久化事件生成确定性 Replay。技术内容可通过 /details 查看。',
      [{ title: '下一步', lines: ['可继续使用 /status 或 /evidence 检查当前 Run。'] }],
      value,
    );
  }
  if (isTrainingStatus(record)) return training(record, value);
  if (isEvidence(record)) return evidence(record, value);
  if (isRag(record)) return rag(record, value);
  if (isRecommendation(record)) return recommendation(record, value);
  if (record.runId || record.currentState || record.status) {
    return workflow(record, value);
  }
  return response(
    kind,
    '操作完成',
    text(record.message) ?? text(record.response) ?? '命令已完成。',
    summarizeRecord(record),
    value,
  );
};

const inferenceSelection = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const selection = asRecord(record.selection);
  const providers = Array.isArray(record.providers) ? record.providers : [];
  const lines = providers.map((item) => {
    const provider = asRecord(item) ?? {};
    const selected = provider.selected === true ? '当前' : '可选';
    const status = provider.configured === true ? '配置可用' : '配置不完整';
    return `${human(provider.id)} · ${human(provider.configuredModel ?? '未选择模型')} · ${selected} · ${status}`;
  });
  const summary = text(record.message) ?? (selection
    ? `当前使用 ${human(selection.providerId)}/${human(selection.model)}。`
    : '当前没有可用的外部模型，将使用确定性后备。');
  return response(
    text(record.kind) ?? 'inference.model',
    '语言模型配置',
    summary,
    lines.length ? [{ title: '供应商', lines }] : undefined,
    raw,
  );
};

const workflow = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const state = text(record.currentState);
  const status = text(record.status) ?? text(record.disposition);
  const effectiveState = status === 'failed'
    ? 'Failed'
    : status === 'quarantined'
      ? 'Quarantined'
      : status === 'cancelled'
        ? 'Cancelled'
        : state;
  const label = stateLabel(effectiveState);
  const output = asRecord(record.output);
  const receipt =
    asRecord(record.trainingReceipt) ?? asRecord(output?.trainingReceipt);
  const structuredFailure = asRecord(receipt?.failure);
  const progress = number(receipt?.progress);
  const warnings: string[] = [...strings(record.warnings)];
  const failure =
    text(structuredFailure?.summary) ??
    text(receipt?.errorMessage) ??
    text(receipt?.quarantineReason) ??
    (status === 'failed' ? text(record.pendingReason) : undefined);
  if (failure) warnings.push(failure);
  const sections: HumanSection[] = [];
  if (record.runId) {
    sections.push({
      title: '任务',
      lines: [`Run：${human(record.runId)}`],
    });
  }
  if (receipt) {
    sections.push({
      title: '训练',
      lines: [
        `训练 ID：${human(receipt.trainingRunId)}`,
        `进度：${human(receipt.progress)}%`,
        `当前步骤：${trainingStageLabel(receipt.currentStep)}`,
      ],
    });
  }
  if (
    state === 'ResearchClarification' &&
    text(record.pendingReason)
  ) {
    sections.push({
      title: '请回答',
      lines: [text(record.pendingReason)!],
    });
  }
  if (
    state === 'ColumnConfirmation' &&
    text(record.pendingReason)
  ) {
    sections.push({
      title: '需要确认',
      lines: ['请确认正文列、时间列、ID 列和元数据列。'],
    });
  }
  if (
    state === 'AwaitDatasetUnderstandingConfirmation' &&
    text(record.pendingReason)
  ) {
    const understanding = asRecord(record.datasetUnderstanding);
    const contentSummary = asRecord(understanding?.contentSummary);
    const excerpts = Array.isArray(contentSummary?.sampleExcerpts)
      ? contentSummary.sampleExcerpts.map(asRecord).filter(Boolean)
      : [];
    sections.push({
      title: '需要确认',
      lines: [
        text(record.pendingReason)!,
        '确认无误后继续；如果领域、分析单位或列角色不正确，请直接用自然语言指出。',
      ],
    });
    if (excerpts.length > 0) {
      sections.push({
        title: '脱敏原始内容样本',
        lines: excerpts.slice(0, 5).map((sample, index) =>
          `${index + 1}. ${human(sample?.text)}`,
        ),
      });
    }
    if (text(contentSummary?.summary)) {
      sections.push({
        title: '数据基本理解',
        lines: [
          text(contentSummary?.summary)!,
          ...(strings(contentSummary?.contentKeywords).length > 0
            ? [`样本内容词：${strings(contentSummary?.contentKeywords).join('、')}`]
            : []),
        ],
      });
    }
  }
  if (
    state === 'ResearchIntentInterview' &&
    text(record.pendingReason)
  ) {
    sections.push({
      title: '请回答',
      lines: [text(record.pendingReason)!],
    });
  }
  if (state === 'AwaitResearchIntentConfirmation') {
    const intentSummary = asRecord(record.researchIntentSummary);
    const comparison = asRecord(intentSummary?.comparison);
    const temporal = asRecord(intentSummary?.temporal);
    if (intentSummary) {
      sections.push({
        title: '研究意图摘要',
        lines: [
          pair('研究问题', intentSummary.researchQuestion),
          pair(
            '比较用途',
            comparison?.enabled === true
              ? `${strings(comparison.dimensions).join('、')}（${comparison.purpose === 'model' ? '进入模型估计' : '仅结果展示'}）`
              : '不比较',
          ),
          pair(
            '时间用途',
            temporal?.enabled === true
              ? `${strings(temporal.columns).join('、') || '时间列'}（${temporal.purpose === 'topic_evolution' ? '模型学习主题演化' : '训练后绘制趋势'}）`
              : '不做时间分析',
          ),
          pair('主题粒度', intentSummary.topicGranularity),
          pair('成功标准', strings(intentSummary.successCriteria).join('；')),
          pair('交付内容', strings(intentSummary.deliverables).join('、')),
          pair('约束', strings(intentSummary.constraints).join('；')),
        ].filter((line): line is string => Boolean(line)),
      });
    }
  }
  return {
    kind: 'workflow.status',
    title: label.title,
    summary:
      failure ??
      (status === 'waiting_timer'
        ? '训练正在后台运行，系统可以自动继续跟踪。'
        : label.explanation),
    progress: {
      current: label.step,
      total: WORKFLOW_TOTAL_STEPS,
      label: label.title,
      ...(progress === undefined ? {} : { percent: progress }),
    },
    ...(sections.length ? { sections } : {}),
    ...(warnings.length ? { warnings } : {}),
    nextActions: resolveNextActions(effectiveState, status),
    technicalDetails: raw,
  };
};

const runExplanation = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => ({
  kind: 'run.explanation',
  title: record.status === 'failed' ? '失败原因' : '当前状态说明',
  summary: text(record.reason) ?? '当前没有更多可解释信息。',
  sections: [
    {
      title: '定位',
      lines: [
        pair('错误类型', record.reasonCode),
        pair('发生阶段', record.stage),
        pair('训练日志', record.logPath),
        record.partialArtifactsAvailable === true
          ? '已有部分训练产物，可以先使用 /results 查看。'
          : '',
      ].filter((line): line is string => Boolean(line)),
    },
    ...(strings(record.suggestedCommands).length
      ? [
          {
            title: '建议处理',
            lines: strings(record.suggestedCommands),
          },
        ]
      : []),
    ...(Array.isArray(record.explanationSections)
      ? record.explanationSections
          .map(asRecord)
          .filter(Boolean)
          .map((item) => ({
            title: text(item?.title) ?? '方案解释',
            lines: strings(item?.lines),
          }))
      : []),
  ],
  ...(text(record.technicalDetail)
    ? { warnings: [text(record.technicalDetail)!] }
    : {}),
  nextActions: resolveNextActions(
    text(record.currentState),
    text(record.status),
  ),
  technicalDetails: raw,
});

const researchAnswer = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const workflowRecord = asRecord(record.workflow);
  const changed = strings(record.changedFields).map(fieldLabel);
  const responseText = text(record.response);
  return {
    kind: text(record.kind) ?? 'research.answer',
    title: record.kind === 'research.answer.unresolved' ? '需要补充说明' : '研究档案已更新',
    summary:
      responseText ??
      (changed.length
        ? `已记录：${changed.join('、')}。`
        : '这次回答还不足以更新研究档案。'),
    sections: changed.length
      ? [{ title: '本轮新增信息', lines: changed.map((item) => `已确认：${item}`) }]
      : undefined,
    nextActions: resolveNextActions(
      workflowRecord?.currentState ?? 'ResearchClarification',
      workflowRecord?.status,
    ),
    technicalDetails: raw,
  };
};

const researchBrief = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const brief = asRecord(record.current) ?? {};
  const lines = [
    pair('研究问题', brief.researchQuestion),
    pair('分析单位', brief.analysisUnit),
    pair('正文含义', brief.textFieldIntent),
    pair('数据来源', strings(brief.dataSources).join('、')),
    pair('比较对象', strings(brief.comparisonGroups).join('、')),
    pair('成功标准', strings(brief.successCriteria).join('；')),
    pair('主题粒度', brief.topicGranularity),
    pair('时间趋势', brief.trendAnalysis === true ? '需要' : '不需要或尚未确认'),
    pair('离线运行', brief.offlineOnly === false ? '否' : '是'),
    pair('敏感数据', asRecord(brief.sensitiveData)?.status),
  ].filter((line): line is string => Boolean(line));
  const missing = strings(brief.unknownFields).map(fieldLabel);
  const completeness = briefCompleteness(brief);
  return {
    kind: 'research.brief',
    title: '当前研究档案',
    summary: missing.length
      ? `已经记录 ${lines.length} 项信息，仍有 ${missing.length} 项待完善。`
      : '研究档案的必填信息已经完整。',
    progress: {
      current: completeness.completed,
      total: completeness.total,
      label: '研究设置完整度',
      percent: (completeness.completed / completeness.total) * 100,
    },
    sections: [
      { title: '已理解', lines },
      ...(missing.length
        ? [{ title: '仍需确认', lines: missing }]
        : []),
    ],
    nextActions: resolveNextActions('ResearchClarification'),
    technicalDetails: raw,
  };
};

const columns = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const draft = asRecord(record.draft) ?? asRecord(record.proposedDraft);
  const workflowRecord = asRecord(record.workflow);
  const lines = draft
    ? [
        `正文列：${strings(draft.textColumns).join('、') || '未确认'}`,
        `时间列：${human(draft.timeColumn ?? '无')}`,
        `ID 列：${human(draft.idColumn ?? '无')}`,
        `训练协变量：${strings(draft.covariateColumns).join('、') || '无'}`,
        `展示分组：${strings(draft.groupingColumns).join('、') || '无'}`,
      ]
    : [`可用列：${strings(record.columns).join('、')}`];
  return {
    kind: text(record.kind) ?? 'columns',
    title: record.kind === 'columns.confirmed' ? '数据列已确认' : '列信息需要补充',
    summary:
      text(record.explanation) ??
      text(record.response) ??
      '请明确正文、时间、ID、训练协变量和展示分组列。',
    sections: [{ title: '列角色', lines }],
    nextActions: resolveNextActions(
      workflowRecord?.currentState ?? 'ColumnConfirmation',
      workflowRecord?.status,
    ),
    technicalDetails: raw,
  };
};

const plan = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const nativePresentation = asRecord(record.plannerPresentationV2);
  if (nativePresentation) return nativePlannerPlan(record, nativePresentation, raw);
  const candidate =
    asRecord(record.validatedPlan) ??
    asRecord(record.candidatePlan) ??
    asRecord(asRecord(record.planRecord)?.canonicalPlan) ??
    {};
  const model = asRecord(candidate.model) ?? candidate;
  const columnsRecord = asRecord(candidate.columns) ?? {};
  const resources = asRecord(candidate.resources) ?? {};
  const parameters =
    asRecord(candidate.hyperparameters) ??
    asRecord(model.parameters) ??
    asRecord(candidate.parameters) ??
    {};
  const review = asRecord(asRecord(record.planRecord)?.review) ?? {};
  const recommendation = asRecord(record.recommendation) ?? {};
  const evidenceBundle = asRecord(record.evidenceBundle) ?? {};
  const proposalEnvelope = asRecord(record.planProposal) ?? {};
  const proposal = asRecord(proposalEnvelope.draft) ?? {};
  const plannerSource = text(proposalEnvelope.source);
  const plannerFallbackReason = text(proposalEnvelope.fallbackReason);
  const plannerFallbackLabels: Record<string, string> = {
    planner_not_enabled: '当前 Run 未启用语言模型 Planner',
    provider_not_configured: '未配置语言模型供应商',
    network_failure: '语言模型网络请求失败',
    timeout: '语言模型 Planner 请求超时',
    provider_error: '语言模型供应商返回错误',
    schema_validation_failed: '语言模型紧凑方案结构无效',
    evidence_violation: '语言模型证据选择未通过兼容性校验',
    catalog_violation: '语言模型选择超出本地模型或参数目录',
  };
  const plannerStatusLines = plannerSource === 'provider'
    ? ['语言模型 Planner：已采纳；模型角色、实验协议与证据绑定均通过治理校验。']
    : [
        '语言模型 Planner：未采纳；当前执行的是确定性后备方案。',
        plannerFallbackReason
          ? `回退原因：${plannerFallbackLabels[plannerFallbackReason] ?? plannerFallbackReason}。`
          : undefined,
        text(proposalEnvelope.fallbackDetail)
          ? `技术摘要：${text(proposalEnvelope.fallbackDetail)}`
          : undefined,
      ].filter((item): item is string => Boolean(item));
  const experimentProtocol =
    asRecord(candidate.experimentProtocol) ??
    asRecord(proposal.experimentProtocol) ??
    {};
  const plannerPrimary = asRecord(proposal.primary) ?? {};
  const plannerResolution = asRecord(record.plannerResolution) ?? {};
  const validation = asRecord(record.validation) ?? {};
  const degradation = asRecord(recommendation.degradation) ?? {};
  const ranked = Array.isArray(recommendation.recommendations)
    ? recommendation.recommendations.map(asRecord).filter(Boolean)
    : [];
  const primary =
    ranked.find((item) => text(item?.modelId) === text(plannerPrimary.modelId)) ??
    ranked[0] ??
    {};
  const recommendedParameters = Array.isArray(primary.parameters)
    ? primary.parameters.map(asRecord).filter(Boolean)
    : [];
  const parameterDecisions =
    asRecord(plannerResolution.parameterDecisions) ??
    asRecord(review.parameterDecisions) ??
    {};
  const parameterDecisionLines = renderParameterDecisions(
    parameterDecisions,
    recommendedParameters,
  );
  const datasetProfile = asRecord(record.datasetProfile) ?? {};
  const researchBrief = asRecord(record.researchBrief) ?? {};
  const recommendationLines = [
    ...translateReasonCodes(strings(primary.reasonCodes)),
    ...recommendedParameters.slice(0, 6).map(
      (item) =>
        `${fieldLabel(human(item?.name))}：系统原建议 ${human(item?.recommended)}；调高会${translateParameterEffect(item?.effectIfHigher)}，调低会${translateParameterEffect(item?.effectIfLower)}。`,
    ),
  ];
  const alternatives = ranked
    .slice(1, 3)
    .map(
      (item) =>
        `${human(item?.modelName ?? item?.modelId)}：评分 ${human(item?.score)}，比主方案低 ${Math.max(0, (number(primary.score) ?? 0) - (number(item?.score) ?? 0))} 分；${strings(item?.warnings).map(translateWarning).join('；') || '综合匹配度低于主方案'}。`,
    );
  const skippedLines = Array.isArray(recommendation.skipped)
    ? recommendation.skipped
        .map(asRecord)
        .filter(Boolean)
        .slice(0, 8)
        .map(
          (item) =>
            `${human(item?.modelId)}：未进入候选，因为 ${strings(item?.reasonCodes).join('、') || '不满足硬约束'}。`,
        )
    : [];
  const plannerDecisionLines = [
    text(proposal.summary),
    text(plannerPrimary.choice),
    ...strings(plannerPrimary.assumptions).map((item) => `假设：${item}`),
  ].filter((item): item is string => Boolean(item));
  const plannerRisks = strings(plannerPrimary.risks).map((item) => `规划风险：${item}`);
  const evidenceReceipts = Array.isArray(proposalEnvelope.evidenceSelectionReceipts)
    ? proposalEnvelope.evidenceSelectionReceipts.map(asRecord).filter(Boolean)
    : [];
  const evidenceReceiptLines = evidenceReceipts.map((receipt) => {
    const bindings = Array.isArray(receipt?.bindings) ? receipt.bindings.length : 0;
    const issues = Array.isArray(receipt?.issues)
      ? receipt.issues.map(asRecord).filter(Boolean)
      : [];
    const summary = `${human(receipt?.receiptId)}：${receipt?.outcome === 'accepted' ? '证据兼容性校验通过' : '证据绑定被拒绝'}，检查 ${bindings} 个决策目标${issues.length ? `，发现 ${issues.length} 个问题` : ''}。`;
    return [
      summary,
      ...issues.slice(0, 3).map(
        (issue) =>
          `  ${human(issue?.targetId)}：${human(issue?.code)}${text(issue?.evidenceId) ? `（${text(issue?.evidenceId)}）` : ''}`,
      ),
    ];
  }).flat();
  const evaluationLines = Array.isArray(proposal.evaluation)
    ? proposal.evaluation.map(asRecord).filter(Boolean).map((item) => human(item?.choice))
    : [];
  const primarySeeds = numbers(experimentProtocol.primarySeeds);
  const baselineSeeds = numbers(experimentProtocol.baselineSeeds);
  const baselineModelId = text(experimentProtocol.baselineModelId);
  const protocolMode = text(experimentProtocol.mode) ?? 'quick';
  const protocolRunCount = primarySeeds.length + baselineSeeds.length;
  const experimentLines = [
    `实验类型：${protocolMode === 'comparative' ? '主模型与基线对照' : protocolMode === 'stability' ? '主模型稳定性复验' : '单次快速运行'}`,
    `真实训练次数：${protocolRunCount || 1} 次`,
    `主模型随机种子：${primarySeeds.join('、') || '42'}`,
    baselineModelId
      ? `对照模型：${baselineModelId.toUpperCase()}（随机种子 ${baselineSeeds.join('、')}）`
      : '对照模型：无',
    text(experimentProtocol.rationale)
      ? `设计理由：${text(experimentProtocol.rationale)}`
      : undefined,
  ].filter((item): item is string => Boolean(item));
  const preprocessingLines = Array.isArray(proposal.preprocessing)
    ? proposal.preprocessing.map(asRecord).filter(Boolean).map((item) => human(item?.choice))
    : [];
  const openQuestionLines = strings(proposal.openQuestions);
  const acceptedEvidenceRefs = new Set(strings(plannerResolution.acceptedEvidenceRefs));
  const allEvidence = Array.isArray(evidenceBundle.evidence)
    ? evidenceBundle.evidence.map(asRecord).filter(Boolean)
    : [];
  const evidenceLines = [
    ...allEvidence.filter((item) => acceptedEvidenceRefs.has(text(item?.evidenceId) ?? '')),
    ...allEvidence,
  ]
    .filter((item, index, items) =>
      items.findIndex((candidate) => text(candidate?.evidenceId) === text(item?.evidenceId)) === index,
    )
    .slice(0, 6)
    .map((item) => {
      const citation = [
        text(item?.sourceYear),
        text(item?.authority),
        text(item?.sourceId),
      ].filter(Boolean).join(' · ');
      return `${human(item?.title ?? item?.objectId ?? item?.sourceId)}${citation ? `（${citation}）` : ''}`;
    });
  const conflictLines = Array.isArray(evidenceBundle.conflicts)
    ? evidenceBundle.conflicts
        .map(asRecord)
        .filter(Boolean)
        .slice(0, 4)
        .map((item) => `需区分：${human(item?.summary)}`)
    : [];
  const uncertaintyLines = Array.isArray(evidenceBundle.uncertainties)
    ? evidenceBundle.uncertainties
        .map(asRecord)
        .filter(Boolean)
        .slice(0, 5)
        .map((item) => human(item?.message))
    : [];
  const rejectedPlannerFields = Array.isArray(plannerResolution.rejectedFields)
    ? plannerResolution.rejectedFields
        .map(asRecord)
        .filter(Boolean)
        .map((item) => `${human(item?.field)}：${human(item?.reason)}`)
    : [];
  const validatorLines = [
    validation.valid === true
      ? `Validator ${human(validation.validatorVersion ?? 'V2')} 已通过；可执行参数以校验后的方案为准。`
      : undefined,
    strings(plannerResolution.acceptedFields).length
      ? `采纳的 Planner 参数：${strings(plannerResolution.acceptedFields).join('、')}`
      : 'Planner 没有直接覆盖确定性参数。',
    ...rejectedPlannerFields.map((item) => `未采纳：${item}`),
  ].filter((item): item is string => Boolean(item));
  const state = text(record.currentState);
  const topicCountMode = text(model.topicCountMode ?? candidate.topicCountMode);
  const topicCountDisplay =
    topicCountMode === 'auto'
      ? model.maxTopics ?? candidate.maxTopics
        ? `自动推断（最多 ${human(model.maxTopics ?? candidate.maxTopics)} 个）`
        : '自动推断'
      : topicCountMode === 'target_reduction'
        ? `自动发现后缩减到约 ${human(model.numTopics ?? candidate.numTopics)} 个`
        : model.numTopics ?? parameters.numTopics ?? candidate.numTopics;
  const lines = [
    pair('模型', model.modelId),
    pair('模型成熟度', primary.maturity),
    pair('训练模式', model.mode),
    pair('主题数', topicCountDisplay),
    pair('批大小', candidate.batchSize ?? parameters.batchSize),
    pair(
      String(model.modelId).toLowerCase() === 'btm'
        ? 'Gibbs 采样迭代'
        : '训练轮次',
      candidate.epochs ?? parameters.epochs,
    ),
    pair('数据集哈希', shortHash(candidate.datasetSha256)),
    pair(
      '正文列',
      strings(candidate.textColumns).join('、') ||
        strings(columnsRecord.textColumns).join('、') ||
        candidate.textColumn,
    ),
    pair('时间列', columnsRecord.timeColumn),
    pair('ID 列', columnsRecord.idColumn),
    pair('训练协变量列', strings(columnsRecord.covariateColumns).join('、')),
    pair('描述元数据列', strings(columnsRecord.metadataColumns).join('、')),
    pair('展示分组列', strings(columnsRecord.groupingColumns).join('、')),
    pair('评估标签列', strings(columnsRecord.evaluationLabelColumns).join('、')),
    pair('运行设备', resources.device),
    pair(
      '网络访问',
      resources.networkAllowed === undefined
        ? undefined
        : resources.networkAllowed
          ? '允许'
          : '禁止',
    ),
  ].filter((line): line is string => Boolean(line));
  const warnings = uniqueStrings([
    ...strings(review.warnings),
    ...strings(recommendation.warnings),
    ...(degradation.required === true
      ? [
          `当前没有模型能同时满足全部硬性研究能力：${strings(degradation.unmetRequirements).join('、') || '未说明'}。必须调整模型，或在审批时明确接受降级。`,
        ]
      : []),
    ...(researchBrief.trendAnalysis === true &&
    text(model.modelId)?.toLowerCase() !== 'dtm'
      ? [
          '当前模型不会直接生成原生时间趋势主题；如时间变化是核心研究目标，应优先比较 DTM 等时间感知方案。',
        ]
      : []),
    ...(strings(researchBrief.comparisonGroups).length > 0 &&
    ['btm', 'lda', 'hdp'].includes(text(model.modelId)?.toLowerCase() ?? '')
      ? [
          '当前模型不会直接利用 source 等分组元数据；本次训练可能无法生成分组比较图。',
        ]
      : []),
  ]).map(translateWarning);
  return {
    kind: 'plan.review',
    title:
      state === 'Completed'
        ? '已执行的训练方案'
        : state === 'AwaitTrainingStartApproval'
        ? '审批 2/2：启动真实训练'
        : '审批 1/2：确认训练方案',
    summary:
      state === 'Completed'
        ? '该方案已经完成两次人工审批、真实训练和产物验证。'
        : state === 'AwaitTrainingStartApproval'
        ? '正式计划和训练前检查已经完成。请确认后再启动真实训练。'
        : '候选训练方案已经生成。批准计划不会立即启动训练。',
    sections: [
      {
        title: '方案摘要',
        lines: lines.length ? lines : ['方案详情已生成，可用 /details 查看完整结构。'],
      },
      ...(parameterDecisionLines.length
        ? [{ title: '参数采用值', lines: parameterDecisionLines }]
        : []),
      {
        title: '审批说明',
        lines:
          state === 'Completed'
            ? [
                '该方案已经执行完成；这里展示的是持久化的最终参数。',
                '如需修改参数并重训，请创建新的 Run。',
              ]
            : state === 'AwaitTrainingStartApproval'
            ? [
                '这是第二次审批：批准后会启动真实训练并写入本地结果目录。',
                '退出跟踪不会取消后台训练。',
              ]
            : [
                '这是第一次审批：只固化训练方案，不会启动训练。',
                '如需修改参数，请先使用 /adjust。',
              ],
      },
      ...(recommendationLines.length
        ? [{ title: '推荐解释', lines: recommendationLines }]
        : []),
      ...(plannerStatusLines.length
        ? [{ title: 'Planner 状态', lines: plannerStatusLines }]
        : []),
      ...(plannerDecisionLines.length
        ? [{
            title: proposalEnvelope.source === 'provider' ? '语言模型规划判断' : '确定性后备规划',
            lines: plannerDecisionLines,
          }]
        : []),
      {
        title: '本次实验设计',
        lines: experimentLines,
      },
      ...(evaluationLines.length
        ? [{
            title: '验收与评估',
            lines: evaluationLines,
          }]
        : []),
      ...(preprocessingLines.length
        ? [{ title: '数据准备', lines: preprocessingLines }]
        : []),
      ...(evidenceLines.length
        ? [{ title: '关键证据', lines: evidenceLines }]
        : []),
      ...(validatorLines.length
        ? [{ title: '可执行性校验', lines: validatorLines }]
        : []),
      ...([...conflictLines, ...uncertaintyLines].length
        ? [{ title: '证据边界与不确定性', lines: [...conflictLines, ...uncertaintyLines] }]
        : []),
      ...(openQuestionLines.length
        ? [{ title: '仍需确认', lines: openQuestionLines }]
        : []),
      ...(alternatives.length
        ? [{ title: '为什么没有选择其他模型', lines: [...alternatives, ...skippedLines] }]
        : skippedLines.length
          ? [{ title: '为什么没有选择其他模型', lines: skippedLines }]
        : []),
      ...(evidenceReceiptLines.length
        ? [{ title: '证据绑定审计', lines: evidenceReceiptLines }]
        : []),
    ],
    ...([
      ...warnings,
      ...plannerRisks,
      ...(number(datasetProfile.rowCount) !== undefined &&
      number(datasetProfile.rowCount)! < 100
        ? [
            `当前数据只有 ${number(datasetProfile.rowCount)} 条，适合流程验证和探索，不足以支持稳定的正式研究结论。`,
          ]
        : []),
    ].length
      ? {
          warnings: [
            ...warnings,
            ...(number(datasetProfile.rowCount) !== undefined &&
            number(datasetProfile.rowCount)! < 100
              ? [
                  `当前数据只有 ${number(datasetProfile.rowCount)} 条，适合流程验证和探索，不足以支持稳定的正式研究结论。`,
                ]
              : []),
          ],
        }
      : {}),
    nextActions: resolveNextActions(state ?? 'AwaitPlanCreationApproval'),
    technicalDetails: raw,
  };
};

const nativePlannerPlan = (
  record: Record<string, unknown>,
  presentation: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const candidate = asRecord(record.validatedPlan) ?? asRecord(record.candidatePlan) ?? {};
  const facts = asRecord(record.datasetFacts) ?? {};
  const confirmation = asRecord(record.datasetConfirmation) ?? {};
  const intent = asRecord(record.researchIntent) ?? {};
  const experiment = asRecord(presentation.experiment) ?? {};
  const primary = asRecord(presentation.primaryModel) ?? {};
  const baseline = asRecord(presentation.baselineModel);
  const keyParameters = Array.isArray(presentation.keyParameters)
    ? presentation.keyParameters.map(asRecord).filter(Boolean)
    : [];
  const preprocessing = Array.isArray(presentation.preprocessing)
    ? presentation.preprocessing.map(asRecord).filter(Boolean)
    : [];
  const evidenceIds = new Set(strings(presentation.evidenceRefs));
  const evidenceBundle = asRecord(record.evidenceBundle) ?? {};
  const evidence = Array.isArray(evidenceBundle.evidence)
    ? evidenceBundle.evidence.map(asRecord).filter(Boolean)
    : [];
  const selectedEvidence = evidence.filter((item) => evidenceIds.has(text(item?.evidenceId) ?? ''));
  const evidenceReceipts = Array.isArray(presentation.evidenceSelectionReceipts)
    ? presentation.evidenceSelectionReceipts.map(asRecord).filter(Boolean)
    : [];
  const state = text(record.currentState);
  const sourceLabel = (source: unknown): string =>
    source === 'user_override' ? '用户覆盖' : source === 'validated_default' ? '校验默认值' : '语言模型建议';
  const parameterLines = keyParameters.map((item) =>
    `${fieldLabel(human(item?.field))}：${human(item?.value)}（${sourceLabel(item?.source)}）${text(item?.rationale) ? `；${text(item?.rationale)}` : ''}`,
  );
  const experimentLines = [
    pair('实验模式', experiment.mode),
    pair('主模型随机种子', numbers(experiment.primarySeeds).join('、')),
    baseline ? pair('基线模型', baseline.modelId) : '基线模型：无',
    baseline ? pair('基线随机种子', numbers(experiment.baselineSeeds).join('、')) : undefined,
    text(experiment.rationale) ? `设计理由：${text(experiment.rationale)}` : undefined,
  ].filter((line): line is string => Boolean(line));
  const dataLines = [
    `数据量：${human(facts.rowCount)} 行，${Array.isArray(facts.columns) ? facts.columns.length : 0} 列`,
    `正文列：${strings(confirmation.textColumns).join('、') || human(candidate.textColumn)}`,
    strings(confirmation.timeColumns).length
      ? `时间列：${strings(confirmation.timeColumns).join('、')}`
      : '时间列：无',
    strings(confirmation.covariateColumns).length
      ? `训练协变量：${strings(confirmation.covariateColumns).join('、')}`
      : '训练协变量：无',
    strings(confirmation.groupColumns).length
      ? `展示分组：${strings(confirmation.groupColumns).join('、')}`
      : '展示分组：无',
  ];
  const evidenceLines = selectedEvidence.map((item) => {
    const citation = [text(item?.authority), text(item?.sourceId)].filter(Boolean).join(' · ');
    return `${human(item?.title ?? item?.objectId ?? item?.evidenceId)}${citation ? `（${citation}）` : ''}`;
  });
  const warnings = uniqueStrings([
    ...strings(presentation.cautions),
    ...strings(presentation.assumptions).map((item) => `规划假设：${item}`),
  ]);
  return {
    kind: 'plan.review',
    title: state === 'AwaitTrainingStartApproval'
      ? '审批 2/2：启动真实训练'
      : state === 'Completed'
        ? '已执行的训练方案'
        : text(presentation.title) ?? '审批 1/2：确认语言模型训练方案',
    summary: text(presentation.summary) ??
      `语言模型建议使用 ${human(primary.modelId ?? presentation.model)} 完成“${human(intent.researchQuestion)}”。`,
    sections: [
      {
        title: '为什么选择这个模型',
        lines: [
          `主模型：${human(primary.modelId ?? presentation.model)}`,
          text(primary.rationale) ?? '模型理由已通过 Planner V2 硬约束校验。',
          ...(baseline ? [`对照模型：${human(baseline.modelId)}；${human(baseline.rationale)}`] : []),
        ],
      },
      { title: '数据依据', lines: dataLines },
      ...(parameterLines.length ? [{ title: '最终参数', lines: parameterLines }] : []),
      { title: '本次实验设计', lines: experimentLines },
      ...(preprocessing.length
        ? [{ title: '数据准备', lines: preprocessing.map((item) => `${human(item?.choice)}${text(item?.rationale) ? `：${text(item?.rationale)}` : ''}`) }]
        : []),
      ...(strings(presentation.evaluation).length
        ? [{ title: '验收与评估', lines: strings(presentation.evaluation) }]
        : []),
      ...(strings(presentation.visualizations).length
        ? [{ title: '计划生成的图表', lines: strings(presentation.visualizations) }]
        : []),
      ...(evidenceLines.length
        ? [{ title: 'Planner 实际采用的证据', lines: evidenceLines }]
        : []),
      ...(evidenceReceipts.some((receipt) => receipt?.outcome === 'rejected')
        ? [{
            title: '证据工具重试记录',
            lines: evidenceReceipts
              .filter((receipt) => receipt?.outcome === 'rejected')
              .map((receipt) =>
                `第 ${human(receipt?.attempt)} 次：${human(receipt?.errorCode)}；目标 ${human(receipt?.targetId ?? '未识别')}；证据 ${human(receipt?.evidenceId ?? '未识别')}；${human(receipt?.message)}`,
              ),
          }]
        : []),
      {
        title: '审批说明',
        lines: state === 'AwaitTrainingStartApproval'
          ? ['批准后才会启动真实训练并写入本地结果目录。']
          : ['本次批准只固化方案，不会立即启动训练。', '如需修改，先使用 /adjust；系统会带着覆盖值重新调用 Planner。'],
      },
    ],
    ...(warnings.length ? { warnings } : {}),
    nextActions: resolveNextActions(state ?? 'AwaitPlanCreationApproval'),
    technicalDetails: raw,
  };
};

const training = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const receipt = asRecord(record.receipt) ?? record;
  const failure = asRecord(receipt.failure);
  const status = text(record.status) ?? text(receipt.status);
  const state =
    status === 'completed'
      ? 'Completed'
      : status === 'failed'
        ? 'Failed'
        : status === 'quarantined'
          ? 'Quarantined'
          : status === 'cancelled'
            ? 'Cancelled'
            : 'MonitorTraining';
  const artifacts = Array.isArray(receipt.resultArtifacts)
    ? receipt.resultArtifacts.map(asRecord).filter(Boolean)
    : [];
  const resultPaths = artifacts
    .map((item) => text(item?.path))
    .filter((item): item is string => Boolean(item));
  return {
    kind: 'training.status',
    title: stateLabel(state).title,
    summary:
      text(failure?.summary) ??
      text(receipt.message) ??
      text(receipt.errorMessage) ??
      stateLabel(state).explanation,
    progress: {
      current: state === 'Completed' ? 7 : 6,
      total: WORKFLOW_TOTAL_STEPS,
      label: trainingStageLabel(receipt.currentStep) ?? stateLabel(state).title,
      percent: number(receipt.progress) ?? (state === 'Completed' ? 100 : 0),
    },
    sections: [
      {
        title: '训练状态',
        lines: [
          pair('训练 ID', receipt.trainingRunId),
          pair('进度', number(receipt.progress) === undefined ? undefined : `${number(receipt.progress)}%`),
          pair('当前阶段', trainingStageLabel(receipt.currentStep)),
          pair('Python', receipt.pythonExecutable),
          pair('日志', receipt.logPath),
        ].filter((line): line is string => Boolean(line)),
      },
      ...(resultPaths.length
        ? [{ title: '结果位置', lines: resultPaths }]
        : []),
      ...(failure
        ? [
            {
              title: '如何处理',
              lines: [
                pair('错误类型', failure?.code),
                ...strings(failure?.suggestedCommands),
              ].filter((line): line is string => Boolean(line)),
            },
          ]
        : []),
    ],
    warnings: [
      text(failure?.technicalDetail),
      text(receipt.quarantineReason),
    ].filter(
      (item): item is string => Boolean(item),
    ),
    nextActions: resolveNextActions(state, status),
    technicalDetails: raw,
  };
};

const recommendation = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const recommendations = Array.isArray(record.recommendations)
    ? record.recommendations.map(asRecord).filter(Boolean)
    : [];
  const primary = recommendations[0] ?? {};
  const profile = asRecord(record.dataProfileSummary) ?? {};
  const parameters = Array.isArray(primary.parameters)
    ? primary.parameters.map(asRecord).filter(Boolean)
    : [];
  const parameterLines = parameters.slice(0, 8).map((item) => {
    const name = human(item?.name);
    const recommended = human(item?.recommended);
    return `${name}：${recommended}（${confidenceLabel(text(item?.confidence))}）`;
  });
  const alternatives = recommendations
    .slice(1, 3)
    .map((item) => `${human(item?.modelName ?? item?.modelId)}：评分 ${human(item?.score)}`);
  return {
    kind: 'recommendation',
    title: `推荐方案：${human(primary.modelName ?? primary.modelId ?? '待确定')}`,
    summary: `当前数据约 ${human(profile.rowCount)} 条，平均文本长度 ${human(profile.averageTextLength)}。首选模型评分 ${human(primary.score)}，置信度为${confidenceLabel(text(primary.confidence))}。`,
    sections: [
      {
        title: '推荐原因',
        lines: translateReasonCodes(strings(primary.reasonCodes)),
      },
      ...(parameterLines.length
        ? [{ title: '建议参数', lines: parameterLines }]
        : []),
      ...(alternatives.length
        ? [{ title: '备选方案', lines: alternatives }]
        : []),
    ],
    warnings: [...strings(record.warnings), ...strings(primary.warnings)],
    nextActions: resolveNextActions('AwaitPlanCreationApproval'),
    technicalDetails: raw,
  };
};

const conversation = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => ({
  kind: 'conversation.turn',
  title: 'THETA 助手',
  summary: text(record.response) ?? '已完成本轮只读查询。',
  nextActions: resolveNextActions(
    undefined,
    undefined,
    record.hasActiveRun === true,
  ),
  technicalDetails: raw,
});

const languageConsent = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => ({
  kind: 'language.consent',
  title: record.enabled === true ? '语言模型辅助已开启' : '语言模型辅助已关闭',
  summary:
    record.enabled === true
      ? '语言模型可以解释回答、润色问题和调用受限只读工具；它不能审批计划或启动训练。'
      : '后续语言处理将使用本地确定性规则。',
  sections: [
    {
      title: '权限边界',
      lines: [
        '可以：理解研究回答、生成追问、解释推荐、选择只读工具。',
        '不可以：改变 FSM 决策、批准计划、启动或取消训练。',
      ],
    },
  ],
  nextActions: resolveNextActions(
    undefined,
    undefined,
    record.hasActiveRun === true,
  ),
  technicalDetails: raw,
});

const runRequired = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => ({
  kind: 'run.required',
  title: '需要先创建分析任务',
  summary:
    text(record.message) ??
    '当前还没有分析任务。请先选择一个本地数据文件创建任务。',
  sections: [
    {
      title: '刚才的命令没有执行',
      lines: [
        `请求：/${text(record.requestedCommand) ?? 'status'}`,
        '系统没有创建隐藏任务，也没有改变任何训练状态。',
      ],
    },
  ],
  nextActions: resolveNextActions(undefined, undefined, false),
  technicalDetails: raw,
});

const history = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const messages = Array.isArray(record.messages)
    ? record.messages.map(asRecord).filter(Boolean)
    : [];
  return {
    kind: 'conversation.history',
    title: '最近对话',
    summary: `当前会话已持久化 ${messages.length} 条消息。`,
    sections: [
      {
        lines: messages.slice(-20).map((message) => {
          const role =
            message?.role === 'user'
              ? '你'
              : message?.role === 'assistant'
                ? 'THETA'
                : '系统';
          return `${role}：${human(message?.content)}`;
        }),
      },
    ],
    nextActions: resolveNextActions(
      undefined,
      undefined,
      record.hasActiveRun === true,
    ),
    technicalDetails: raw,
  };
};

const evidence = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const orchestration = Array.isArray(record.orchestrationEvents)
    ? record.orchestrationEvents
    : [];
  const tools = Array.isArray(record.toolEvents) ? record.toolEvents : [];
  return {
    kind: 'evidence',
    title: '运行证据',
    summary: `已记录 ${orchestration.length} 条工作流事件和 ${tools.length} 条受治理工具事件。`,
    sections: [
      {
        title: '说明',
        lines: [
          '默认只展示摘要，避免审计事件淹没主要信息。',
          '如需完整哈希、载荷和策略记录，请使用 --json 或 /details。',
        ],
      },
    ],
    nextActions: resolveNextActions(undefined),
    technicalDetails: raw,
  };
};

const runResults = (
  record: Record<string, unknown>,
  raw: unknown,
  summaryMode: boolean,
): HumanFacingResponse => {
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.map(asRecord).filter(Boolean)
    : [];
  const metrics = asRecord(record.metrics) ?? {};
  const topics = Array.isArray(record.topics)
    ? record.topics.map(asRecord).filter(Boolean)
    : [];
  const capabilities = asRecord(record.capabilities) ?? {};
  const goalAssessment = Array.isArray(record.goalAssessment)
    ? record.goalAssessment.map(asRecord).filter(Boolean)
    : [];
  const experiments = Array.isArray(record.experiments)
    ? record.experiments.map(asRecord).filter(Boolean)
    : [];
  const comparison = strings(record.comparison);
  const parameterDecisionLines = renderParameterDecisions(
    asRecord(record.parameterDecisions) ?? {},
    [],
  );
  const metricObservations = asRecord(metrics.metric_observations) ?? {};
  const unavailableMetrics = Object.entries(metricObservations)
    .map(([name, value]) => [name, asRecord(value)] as const)
    .filter(([, value]) => value?.status === 'unavailable');
  const metricLines = flattenMetrics(metrics)
    .filter(
      ([key]) =>
        !['model_name', 'dataset', 'num_topics', 'metric_schema_version'].includes(
          key.toLowerCase(),
        ) && !key.toLowerCase().startsWith('metric_observations.'),
    )
    .slice(0, 12)
    .map(([key, item]) => `${metricLabel(key)}：${formatMetric(item)}`);
  const resultRoot = text(record.resultRoot);
  const warnings: string[] = [...strings(record.warnings)];
  if (unavailableMetrics.length) {
    warnings.push(
      `以下指标未成功计算，系统没有使用其他指标冒充：${unavailableMetrics.map(([name]) => name).join('、')}。`,
    );
  }
  if (number(record.progress) !== undefined && number(record.progress)! < 100) {
    warnings.push('训练尚未完成，当前结果可能不完整。');
  }
  const rowCount = metricNumber(metrics, ['document_count', 'documents', 'n_docs']);
  if (rowCount !== undefined && rowCount < 100) {
    warnings.push(
      `当前仅有 ${rowCount} 条文档，结果适合流程验证和探索，不宜直接作为稳定研究结论。`,
    );
  }
  if (
    summaryMode &&
    capabilities.temporalRequested === true &&
    capabilities.hasTimestamps === false
  ) {
    warnings.push(
      '本次结果没有时间戳产物，因此没有生成时间趋势图；这与已声明的时间比较目标不一致。',
    );
  }
  if (
    summaryMode &&
    capabilities.groupComparisonRequested === true &&
    capabilities.hasDimensions === false
  ) {
    warnings.push(
      '本次结果没有分组维度产物，因此没有生成 source 等来源比较图。',
    );
  }
  const topicLines = topics.map((topic) => {
    const strength = number(topic?.strength);
    return `主题 ${human(topic?.id)}「${human(topic?.name)}」${strength === undefined ? '' : `，占比 ${(strength * 100).toFixed(1)}%`}：${strings(topic?.keywords).slice(0, 8).join('、')}`;
  });
  const interpretationLines = summaryMode
    ? interpretMetrics(metrics)
    : [];
  return {
    kind: summaryMode ? 'run.summary' : 'run.results',
    title: summaryMode ? '训练结果摘要' : '训练结果',
    summary: summaryMode
      ? `共识别 ${topics.length || human(metrics.num_topics)} 个主题。下面的解释只依据本次真实产物，不把小样本结果外推为研究结论。`
      : text(record.message) ??
        `训练状态为 ${human(record.status)}，已记录 ${artifacts.length} 个受验证产物。`,
    sections: [
      {
        title: '验收状态',
        lines: [
          `执行：${human(record.executionStatus ?? record.status)}`,
          `质量：${human(record.qualityStatus ?? '尚未评估')}`,
          `研究目标：${human(record.researchStatus ?? '尚未评估')}`,
        ],
      },
      ...(parameterDecisionLines.length
        ? [{ title: '本次执行参数', lines: parameterDecisionLines }]
        : []),
      {
        title: '结果位置',
        lines: [
          ...(resultRoot ? [`完整结果：${resultRoot}`] : []),
          ...(text(record.topicTable)
            ? [`主题表：${text(record.topicTable)}`]
            : []),
          ...(text(record.logPath) ? [`训练日志：${text(record.logPath)}`] : []),
        ].length
          ? [
              ...(resultRoot ? [`完整结果：${resultRoot}`] : []),
              ...(text(record.topicTable)
                ? [`主题表：${text(record.topicTable)}`]
                : []),
              ...(text(record.logPath)
                ? [`训练日志：${text(record.logPath)}`]
                : []),
            ]
          : ['当前尚未绑定结果目录。'],
      },
      ...(metricLines.length
        ? [{ title: '核心指标', lines: metricLines }]
        : []),
      ...(Object.keys(metricObservations).length
        ? [{
            title: '指标来源与可用性',
            lines: Object.entries(metricObservations).map(([name, value]) => {
              const observation = asRecord(value) ?? {};
              return `${name}：${observation.status === 'computed' ? '真实计算' : human(observation.status)}；方法 ${human(observation.method)}${observation.error ? `；${human(observation.error)}` : ''}`;
            }),
          }]
        : []),
      ...(summaryMode && topicLines.length
        ? [{ title: '主题概览', lines: topicLines }]
        : []),
      ...(interpretationLines.length
        ? [{ title: '如何解读', lines: interpretationLines }]
        : []),
      ...(goalAssessment.length
        ? [
            {
              title: '研究目标验收',
              lines: goalAssessment.map((item) => {
                const status =
                  item?.status === 'satisfied'
                    ? '满足'
                    : item?.status === 'not_satisfied'
                      ? '未满足'
                      : '需人工复核';
                return `[${status}] ${human(item?.criterion)}：${human(item?.evidence)}`;
              }),
            },
          ]
        : []),
      ...(experiments.length > 1
        ? [
            {
              title: `本次基线与多随机种子比较（${experiments.length} 个实验）`,
              lines:
                comparison.length > 0
                  ? comparison
                  : ['已发现多次受当前训练回执约束的实验，但没有共同指标可直接比较。'],
            },
          ]
        : []),
      ...(artifacts.length
        ? [
            {
              title: '受验证产物',
              lines: artifacts
                .slice(0, 12)
                .map(
                  (item) =>
                    `${human(item?.kind)}：${human(item?.path)}${item?.exists === true ? '' : '（缺失）'}`,
                ),
            },
          ]
        : []),
    ],
    ...(warnings.length ? { warnings } : {}),
    nextActions: [
      ...resolveNextActions(
      record.status === 'completed' ? 'Completed' : 'MonitorTraining',
      record.status,
      ).filter((item) => !summaryMode || item.id !== 'summary'),
      ...(record.qualityStatus === 'failed'
        ? [{
            id: 'retry',
            label: '创建新训练尝试',
            description: '质量门失败时保留原产物，并基于同一审批链创建新的训练尝试。',
            command: '/retry',
            recommended: true,
          }]
        : []),
    ],
    technicalDetails: raw,
  };
};

const trainingLogs = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const logs = strings(record.logs);
  const receipt = asRecord(record.receipt);
  return {
    kind: 'training.logs',
    title: '最近训练日志',
    summary: `训练状态：${human(record.status)}；显示最近 ${logs.length} 行。`,
    progress: receipt
      ? {
          current: 6,
          total: WORKFLOW_TOTAL_STEPS,
          label: text(receipt.currentStep) ?? '训练中',
          percent: number(receipt.progress) ?? 0,
        }
      : undefined,
    sections: [
      {
        lines: logs.length ? logs : ['当前没有可显示的日志。'],
      },
    ],
    nextActions: resolveNextActions(
      record.status === 'completed' ? 'Completed' : 'MonitorTraining',
      record.status,
    ),
    technicalDetails: raw,
  };
};

const runCatalog = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => {
  const runs = Array.isArray(record.runs)
    ? record.runs.map(asRecord).filter(Boolean)
    : [];
  return {
    kind: 'run.catalog',
    title: '本地任务',
    summary: `找到 ${runs.length} 个持久化任务。`,
    sections: [
      {
        lines: runs.length
          ? runs.map(
              (run, index) =>
                `${index + 1}. ${human(run?.runId)} · ${human(run?.updatedAt)} · ${human(run?.eventCount)} 个事件${run?.recoveryOfRunId ? ` · 恢复自 ${human(run.recoveryOfRunId)}` : ''}${run?.successorRunId ? ` · 后继 ${human(run.successorRunId)}` : ''}`,
            )
          : ['还没有本地任务。使用 /start <数据文件> 创建第一个任务。'],
      },
    ],
    nextActions: [
      {
        id: 'start',
        label: '创建新任务',
        description: '从一个本地数据文件开始。',
        command: '/start <数据文件>',
        recommended: runs.length === 0,
      },
      {
        id: 'repl',
        label: '连接已有任务',
        description: '退出后使用 theta repl --run-id <ID>。',
      },
    ],
    technicalDetails: raw,
  };
};

const rag = (
  record: Record<string, unknown>,
  raw: unknown,
): HumanFacingResponse => ({
  kind: 'rag',
  title:
    record.ready === true || record.status === 'ready'
      ? '本地知识库已就绪'
      : '本地知识库状态',
  summary:
    text(record.message) ??
    `知识来源：${human(record.totalSources ?? record.sourceCount ?? record.sources)}；索引片段：${human(record.totalChunks ?? record.chunkCount ?? record.chunks)}。`,
  nextActions: [
    {
      id: 'start',
      label: '创建训练任务',
      description: '选择本地数据集并开始研究访谈。',
      command: '/start <数据文件>',
      recommended: true,
    },
    {
      id: 'models',
      label: '查看可用模型',
      description: '查看本地 THETA 已注册的模型。',
      command: 'theta models',
    },
  ],
  technicalDetails: raw,
});

const response = (
  kind: string,
  title: string,
  summary: string,
  sections: HumanSection[] | undefined,
  technicalDetails: unknown,
): HumanFacingResponse => ({
  kind,
  title,
  summary,
  ...(sections?.length ? { sections } : {}),
  nextActions: resolveNextActions(undefined),
  technicalDetails,
});

const summarizeRecord = (record: Record<string, unknown>): HumanSection[] => {
  const lines = Object.entries(record)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 8)
    .map(([key, value]) => `${fieldLabel(key)}：${human(value)}`);
  return lines.length ? [{ lines }] : [];
};

const hasPlan = (record: Record<string, unknown>): boolean =>
  Boolean(record.candidatePlan || record.validatedPlan || record.planRecord);

const isTrainingStatus = (record: Record<string, unknown>): boolean =>
  Boolean(record.receipt) ||
  Boolean(record.trainingRunId && (record.progress !== undefined || record.found !== undefined));

const isEvidence = (record: Record<string, unknown>): boolean =>
  Array.isArray(record.orchestrationEvents) || Array.isArray(record.eventTypes);

const isRag = (record: Record<string, unknown>): boolean =>
  Boolean(
    record.sourceCount !== undefined ||
      record.chunkCount !== undefined ||
      record.totalSources !== undefined ||
      record.totalChunks !== undefined ||
      record.indexPath !== undefined,
  );

const isRecommendation = (record: Record<string, unknown>): boolean =>
  Array.isArray(record.recommendations) && record.deterministic === true;

const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const numbers = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];

const human = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '未提供';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(human).join('、');
  return '详情可展开查看';
};

const pair = (label: string, value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return;
  return `${label}：${human(value)}`;
};

const shortHash = (value: unknown): unknown =>
  typeof value === 'string' && value.length > 16 ? `${value.slice(0, 12)}…` : value;

const confidenceLabel = (value: string | undefined): string =>
  value === 'high' ? '高' : value === 'medium' ? '中' : value === 'low' ? '低' : '未知';

const fieldLabels: Readonly<Record<string, string>> = {
  researchQuestion: '研究问题',
  dataSources: '数据来源',
  collectionMethod: '数据收集方式',
  analysisUnit: '分析单位',
  timeRange: '时间范围',
  language: '数据语言',
  comparisonGroups: '比较对象',
  comparisonIntent: '比较需求',
  topicGranularity: '主题粒度',
  knownBiases: '已知偏差',
  sensitiveData: '敏感数据',
  successCriteria: '成功标准',
  hardwareLimit: '本地硬件',
  textFieldIntent: '正文含义',
  trendAnalysis: '时间趋势要求',
  offlineOnly: '离线要求',
  requestedEmbedding: '嵌入方式',
  timeLimitHours: '可用时间',
  modelId: '模型',
  numTopics: '主题数',
  maxTopics: '最大主题数',
  topicCountMode: '主题数模式',
  nNeighbors: 'UMAP 邻居数',
  nComponents: 'UMAP 维度',
  minClusterSize: '最小主题簇',
  minSamples: '核心样本阈值',
  topNWords: '每主题词数',
  batchSize: '批大小',
  epochs: '迭代次数',
  mode: '训练模式',
  randomState: '随机种子',
  covariateColumns: '训练协变量列',
};

const fieldLabel = (value: string): string => fieldLabels[value] ?? value;

const renderParameterDecisions = (
  decisions: Record<string, unknown>,
  recommendations: Array<Record<string, unknown> | undefined>,
): string[] => {
  const order = [
    'modelId',
    'mode',
    'topicCountMode',
    'numTopics',
    'maxTopics',
    'batchSize',
    'epochs',
    'nNeighbors',
    'nComponents',
    'minClusterSize',
    'minSamples',
    'topNWords',
    'randomState',
    'covariateColumns',
  ];
  return Object.entries(decisions)
    .sort(
      ([left], [right]) =>
        sortableIndex(order, left) - sortableIndex(order, right),
    )
    .flatMap(([field, rawDecision]) => {
      const decision = asRecord(rawDecision);
      if (!decision || decision.effectiveValue === undefined) return [];
      const source = text(decision.source) ?? 'system_recommendation';
      const recommended = decision.recommendedValue;
      const effective = decision.effectiveValue;
      const recommendation = recommendations.find(
        (item) => text(item?.name) === field,
      );
      const recommendedNumber = number(recommended);
      const effectiveNumber = number(effective);
      const effect =
        recommendation &&
        recommendedNumber !== undefined &&
        effectiveNumber !== undefined &&
        recommendedNumber !== effectiveNumber
          ? translateParameterEffect(
              effectiveNumber > recommendedNumber
                ? recommendation?.effectIfHigher
                : recommendation?.effectIfLower,
            )
          : undefined;
      const parts = [
        `当前采用：${human(effective)}`,
        source === 'system_recommendation' &&
        JSON.stringify(recommended) === JSON.stringify(effective)
          ? undefined
          : `系统原建议：${human(recommended)}`,
        `调整来源：${parameterDecisionSourceLabel(source)}`,
        effect && effect !== 'undefined' ? `影响：${effect}` : undefined,
      ].filter((item): item is string => Boolean(item));
      return [`${fieldLabel(field)}：${parts.join('；')}`];
    });
};

const sortableIndex = (order: string[], field: string): number => {
  const index = order.indexOf(field);
  return index === -1 ? order.length : index;
};

const parameterDecisionSourceLabel = (source: string): string =>
  ({
    system_recommendation: '系统推荐',
    user_override: '用户修改',
    validator_correction: 'Validator 修正',
  })[source] ?? source;

const trainingStageLabel = (value: unknown): string => {
  const stage = text(value) ?? '等待训练状态';
  const normalized = stage.replace(/_completed$/u, '');
  const primary = normalized.match(/^run_pipeline_primary_([a-z0-9_-]+)_s(\d+)$/u);
  if (primary) return `训练主模型 ${primary[1]?.toUpperCase()}（随机种子 ${primary[2]}）`;
  const baseline = normalized.match(/^run_pipeline_baseline_([a-z0-9_-]+)_s(\d+)$/u);
  if (baseline) return `训练对照模型 ${baseline[1]?.toUpperCase()}（随机种子 ${baseline[2]}）`;
  return ({
    queued: '等待后台执行',
    prepare_data: '读取并准备数据',
    data_prepared: '数据准备完成',
    evaluate_model: '评估模型',
    generate_visualizations: '生成图表',
    verify_visualizations: '验证图表',
    bind_results: '绑定本次结果',
    completed: '训练完成',
  } as Readonly<Record<string, string>>)[normalized] ?? normalized;
};

const reasonLabels: Readonly<Record<string, string>> = {
  THETA_NATIVE_MODEL: '该模型由当前 THETA 训练后端原生支持。',
  EVIDENCE_SUPPORTED: '本地知识库中存在对应的模型依据。',
  SHORT_TEXT_FIT: '数据以短文本为主，模型与短文本特征匹配。',
  SMALL_DATASET_FIT: '当前数据规模较小，优先选择更稳健、可解释的方案。',
  OFFLINE_COMPATIBLE: '可以在当前离线策略下运行。',
  TIME_AWARE: '支持当前研究所需的时间分析。',
  METADATA_AWARE: '能够利用已确认的元数据。',
  RUNNABLE_CATALOG_MODEL: '该模型已在当前本地 THETA 环境中注册并可运行。',
  SHORT_TEXT_BTM: 'BTM 与当前已确认的短文本特征相匹配。',
  COVARIATE_ANALYSIS_STM: 'STM 将使用已明确确认的训练协变量。',
  UNKNOWN_TOPIC_COUNT_HDP: 'HDP 适合当前主题数量未知的探索目标。',
  BASELINE_CLASSICAL_LDA: 'LDA 与经典词袋主题模型基线目标匹配。',
  SEMANTIC_CLUSTERING_BERTOPIC: 'BERTopic 与语义聚类目标和本地嵌入约束匹配。',
  SHORT_TEXT_MATCH: '模型设计与当前短文本数据特征相匹配。',
  COVARIATE_MATCH: '模型可使用当时确认的元数据列。',
  AUTO_TOPIC_COUNT_MATCH: '模型支持自动探索主题数量。',
  BASELINE_GOAL_MATCH: '模型与当时的基线目标匹配。',
};

const translateReasonCodes = (codes: string[]): string[] =>
  codes.length
    ? codes.map((code) => reasonLabels[code] ?? `依据：${code}`)
    : ['推荐来自确定性模型筛选与参数规则。'];

const warningLabels: Readonly<Record<string, string>> = {
  SMALL_CORPUS: '样本量很小，主题和指标可能不稳定。',
  EXPERIMENTAL_MODEL_REQUIRES_HUMAN_REVIEW:
    '当前模型属于实验性实现；可以运行，但结果必须经过人工复核，不能按生产级模型解释。',
  LOCAL_EMBEDDING_DRY_RUN_REQUIRED:
    'BERTopic 依赖本地嵌入资源；启动训练前必须由 Dry Run 验证模型路径和依赖。',
};

const translateWarning = (value: string): string =>
  warningLabels[value] ?? value;

const translateParameterEffect = (value: unknown): string => {
  const textValue = human(value);
  const translations: Readonly<Record<string, string>> = {
    'Increases topic granularity and fragmentation risk.':
      '得到更细的主题，但也更容易把相近主题拆散',
    'Produces broader topics and may merge distinct themes.':
      '得到更宽泛的主题，但可能合并原本不同的主题',
    'Uses more memory and may improve throughput.':
      '占用更多内存，并可能提高训练吞吐',
    'Uses less memory with potentially noisier updates.':
      '减少内存占用，但参数更新可能更不稳定',
    'Increases runtime and overfitting risk.':
      '增加运行时间和过拟合风险',
    'Reduces runtime but may underfit.':
      '缩短运行时间，但可能训练不足',
  };
  return translations[textValue] ?? textValue;
};

const uniqueStrings = (values: string[]): string[] => [...new Set(values)];

const interpretMetrics = (
  metrics: Record<string, unknown>,
): string[] => {
  const td = metricNumber(metrics, ['td']);
  const irbo = metricNumber(metrics, ['irbo']);
  const npmi = metricNumber(metrics, ['npmi']);
  const cv = metricNumber(metrics, ['c_v']);
  const lines: string[] = [];
  if (td !== undefined) {
    lines.push(
      td >= 0.8
        ? `主题多样性 ${td.toFixed(3)} 较高，主题关键词之间重复较少。`
        : `主题多样性 ${td.toFixed(3)} 一般，部分主题可能共享较多关键词。`,
    );
  }
  if (irbo !== undefined) {
    lines.push(
      irbo >= 0.7
        ? `主题差异度 iRBO 为 ${irbo.toFixed(3)}，主题词排序之间区分较明显。`
        : irbo >= 0.4
          ? `主题差异度 iRBO 为 ${irbo.toFixed(3)}，主题之间存在一定区分，但仍有部分重叠。`
          : `主题差异度 iRBO 为 ${irbo.toFixed(3)}，主题词排序高度重叠，需要调整主题数或增加数据。`,
    );
  }
  if (npmi !== undefined || cv !== undefined) {
    lines.push(
      `一致性指标${npmi === undefined ? '' : ` NPMI=${npmi.toFixed(3)}`}${cv === undefined ? '' : `、C_V=${cv.toFixed(3)}`} 偏低，主题内部的语义凝聚度有限；应结合主题重复度、代表文档与人工判断排查主题塌缩。`,
    );
  }
  lines.push(
    '困惑度只能用于相同数据和相同预处理下的模型对比，不能单独判断主题是否“正确”。',
  );
  return lines;
};

const flattenMetrics = (
  value: Record<string, unknown>,
  prefix = '',
): Array<[string, unknown]> => {
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const nested = asRecord(item);
    if (nested) entries.push(...flattenMetrics(nested, fullKey));
    else if (typeof item === 'number' || typeof item === 'string') {
      entries.push([fullKey, item]);
    }
  }
  return entries;
};

const metricLabel = (key: string): string => {
  const normalized = key.split('.').at(-1) ?? key;
  const labels: Readonly<Record<string, string>> = {
    td: '主题多样性（TD）',
    irbo: '主题差异度（iRBO）',
    npmi: '主题一致性（NPMI）',
    c_v: '主题一致性（C_V）',
    umass: '主题一致性（UMass）',
    exclusivity: '主题排他性',
    perplexity: '困惑度',
    ppl: '困惑度',
    document_count: '文档数',
    vocab_size: '词表大小',
  };
  return labels[normalized.toLowerCase()] ?? normalized;
};

const formatMetric = (value: unknown): string =>
  typeof value === 'number'
    ? Number.isInteger(value)
      ? String(value)
      : value.toFixed(4)
    : human(value);

const metricNumber = (
  value: Record<string, unknown>,
  names: string[],
): number | undefined => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return flattenMetrics(value)
    .filter(([key, item]) => wanted.has((key.split('.').at(-1) ?? key).toLowerCase()) && typeof item === 'number')
    .map(([, item]) => item as number)[0];
};

const briefCompleteness = (
  brief: Record<string, unknown>,
): { completed: number; total: number } => {
  const checks = [
    Boolean(text(brief.researchQuestion)),
    Boolean(text(brief.analysisUnit)),
    Boolean(text(brief.textFieldIntent)),
    Boolean(text(asRecord(brief.sensitiveData)?.status)) &&
      text(asRecord(brief.sensitiveData)?.status) !== 'unknown',
    Boolean(text(brief.collectionMethod)),
    strings(brief.comparisonGroups).length > 0,
    strings(brief.successCriteria).length > 0,
    Boolean(text(brief.topicGranularity)),
    strings(brief.knownBiases).length > 0,
    Boolean(text(asRecord(brief.hardwareLimit)?.device)) &&
      text(asRecord(brief.hardwareLimit)?.device) !== 'unknown',
  ];
  return {
    completed: checks.filter(Boolean).length,
    total: checks.length,
  };
};
