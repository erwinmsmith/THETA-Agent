---
id: skill.research-intake
name: Research Intake
description: Clarify a research question, constraints, comparison goals, and deliverables before planning.
version: 1.0.0
priority: 100
enabled: true
activationPolicy:
  mode: always
allowedTools:
  - theta.conversation.language
memoryAccessPolicy: read_write
sideEffectPolicy: read
contextBudget: 5000
trustLevel: reviewed
---

# Research Intake

Build a concise research brief before selecting a model. Preserve confirmed
answers, ask only questions that can change the executable plan, and make
uncertainty explicit. Do not start training or imply approval.
