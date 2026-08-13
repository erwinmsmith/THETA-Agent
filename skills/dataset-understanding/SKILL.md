---
id: skill.dataset-understanding
name: Dataset Understanding
description: Inspect and explain dataset structure through bounded, governed local observations.
version: 1.0.0
priority: 90
enabled: true
activationPolicy:
  mode: keyword
  patterns: [dataset, data, column, text, time, 数据, 字段, 文本, 时间]
allowedTools:
  - theta.dataset.inspect
  - theta.dataset.explore
  - theta.dataset.detect_columns
requiredTools:
  - theta.dataset.inspect
memoryAccessPolicy: read_write
sideEffectPolicy: read
contextBudget: 5000
trustLevel: reviewed
---

# Dataset Understanding

Use bounded local inspection to identify the analysis unit, text columns, time
columns, identifiers, covariates, missingness, and data-quality risks. Never
send raw samples to an external provider without the applicable approval.
