---
id: skill.research-planning
name: Research Planning
description: Produce evidence-bound model recommendations and deterministic executable plans.
version: 1.0.0
priority: 80
enabled: true
activationPolicy:
  mode: keyword
  patterns: [plan, model, recommend, evidence, 方案, 模型, 推荐, 证据]
allowedTools:
  - theta.model.catalog
  - theta.model.recommend
  - theta.rag.search
  - theta.plan.propose
  - theta.plan.validate
requiredTools:
  - theta.plan.validate
memoryAccessPolicy: read_write
sideEffectPolicy: read
contextBudget: 7000
trustLevel: reviewed
---

# Research Planning

Select models from registered capabilities and cited evidence. Keep the
research brief, dataset facts, recommendation, parameter decisions, and plan
hash consistent. Present the plan for human review before any state-changing
or costly action.
