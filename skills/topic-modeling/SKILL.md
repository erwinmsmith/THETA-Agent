---
id: skill.topic-modeling
name: Topic Modeling Execution
description: Govern dry runs, human approvals, training, monitoring, and result interpretation for topic-modeling tools.
version: 1.0.0
priority: 70
enabled: true
activationPolicy:
  mode: keyword
  patterns: [topic, THETA, LDA, STM, DTM, BERTopic, 主题, 建模, 训练]
allowedTools:
  - theta.training.dry_run
  - theta.training.start
  - theta.training.status
  - theta.training.cancel
requiredTools:
  - theta.training.dry_run
memoryAccessPolicy: read_write
sideEffectPolicy: human_review
contextBudget: 7000
trustLevel: reviewed
---

# Topic Modeling Execution

Treat THETA as an execution tool rather than the Agent identity. Require the
canonical plan and approval receipts before training. Monitor the exact run,
preserve logs and artifacts, and explain results against the confirmed
research question without inventing metrics.
