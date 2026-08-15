# THETA Agent CLI 完整手册

[English](CLI.md) | 简体中文

本文档覆盖直接 CLI 与交互式 REPL 的全部用户指令。完成 README 中的安装步骤后，请在仓库根目录执行命令。

## 调用形式与约定

```bash
npm run cli -- <command> [options]
npm start
```

安装命令行程序后，`theta <command>` 与上述 `npm run cli -- <command>` 等价。本文使用仓库命令，确保本地检出后即可执行。

常见占位符：

- `<run-id>`：`start` 或 `workflow run` 返回的持久化工作流 ID。
- `<training-run-id>`：训练真正启动后返回的执行 ID。
- `<dataset-ref>`：`dataset register` 返回的不透明数据引用。
- `--runtime-db <path>`：指定其他 SQLite 运行库；默认使用 `.theta_agent/theta-workflow.sqlite`。
- `--json`：在支持的命令中输出机器可读 JSON。
- 受审批保护的命令不带 `--approve` 时只做安全预览；审查输出后，再带 `--approve` 重复执行。

首先使用仓库规定的 Node.js 版本：

```bash
nvm use
npm run build
npm run cli -- --help
```

## 推荐的完整研究流程

日常研究建议使用 REPL，它统一管理对话、追问、规划、两次审批、训练与结果：

```bash
npm start
```

```text
/start fixtures/sample.jsonl
直接用自然语言回答研究问题
/next
/plan
/approve-plan
/start-training
/follow
/results
/summary
/exit
```

直接的底层命令主要用于自动化、诊断和契约测试。不要混用不同 Run 产生的计划哈希、审批 ID 或 Dry-run 回执。

## 环境与模型切换

系统默认使用 DeepSeek。可以手工复制模板并填写 Key，也可以从同级 Hypha 工作副本安全导入：

```bash
cp .env.example .env
npm run env:import:hypha
```

导入命令只复制 DeepSeek 相关变量，不会打印 Key，并把 `.env` 权限设为仅本地用户可读写。也可以显式指定来源：

```bash
npm run env:import:hypha -- /absolute/path/to/Hypha/.env
```

### `model list`、`model current`、`model use`、`model reset`

分别用于查看供应商、查看当前模型、保存明确选择，以及清除选择并回到 `.env` 默认值：

```bash
npm run cli -- model list
npm run cli -- model current --json
npm run cli -- model use --provider deepseek --model deepseek-v4-flash
npm run cli -- model reset
```

供应商 ID 包括 `deepseek`、`minimax`、`openai`、`openrouter`、`ollama` 和 `custom`。模型选择保存在被忽略的本地状态中，API Key 只保留在 `.env`。

### `language intent`

对只读意图进行受限分类。不带 `--approve` 时不会授权外部推理，而是返回审批预览或确定性后备：

```bash
npm run cli -- language intent --text "查看当前模型目录"
npm run cli -- language intent --text "查看当前模型目录" --approve --json
```

### `language question`

改写研究问题，但不改变工作流状态或研究决策：

```bash
npm run cli -- language question \
  --text "哪些主题发生了变化？" \
  --field researchQuestion \
  --reason "明确时间比较方式" \
  --approve
```

### `language explain`

解释已有的确定性模型建议。`--confidence` 只能是 `low`、`medium` 或 `high`；原因码和警告使用逗号分隔：

```bash
npm run cli -- language explain \
  --model-id lda --score 80 --confidence medium \
  --reason-codes TEXT_PROFILE_MATCH \
  --warnings NO_EVIDENCE_AVAILABLE \
  --evidence "LDA 支持可解释的语料级主题。" \
  --approve
```

## 诊断与证据

### `doctor`

检查 Node、pnpm、uv/Python、Hypha、THETA、注册表、SQLite、知识库、硬件可见性和当前模型供应商。WARN 不妨碍确定性运行，FAIL 表示必要能力被阻断。

```bash
npm run doctor
npm run cli -- doctor --json
```

### `rag build` 与 `rag status`

构建或查看受治理的本地证据索引：

```bash
npm run cli -- rag status
npm run cli -- rag build
npm run cli -- rag status --json
```

### `audit export` 与 `evidence show`

两者都只读取持久化 Run。前者侧重规范事件与 Tool trace，后者使用 Agent 的可读展示：

```bash
npm run cli -- audit export --run-id <run-id> --json
npm run cli -- evidence show --run-id <run-id>
```

## 持久化 Agent 命令

### `start`

启动与 REPL 相同的 V2 工作流。可使用 `--file`，或通过 `--input` 提交完整 JSON。可选参数包括 `--dataset-id`、`--goal`、`--sample-size`、`--run-id`、`--runtime-db`、`--approved-by`、`--approve-plans`、`--approve-training` 和 `--json`。训练审批必须同时允许计划审批。

```bash
npm run cli -- start --file fixtures/sample.jsonl \
  --goal "发现稳定主题及其时间变化" --sample-size 10

npm run cli -- start --input fixtures/cli/workflow-input.json --json
```

### `resume`

恢复持久化 Run。可使用 `--approve` 或 `--reject` 解决当前审批等待，也可提交 JSON 回答或列确认。两个审批参数不能同时使用。

```bash
npm run cli -- resume --run-id <run-id>
npm run cli -- resume --run-id <run-id> --approve
npm run cli -- resume --run-id <run-id> --answers fixtures/research-answers.json
npm run cli -- resume --run-id <run-id> --columns fixtures/column-confirmation.json
```

V2 的数据确认、决策回答和计划调整使用后文的 `workflow resume`。

### `answer` 与 `columns`

在 REPL 外提交单轮自然语言回答。两者都需要 Run ID；自动化任务可用 `--session-id` 隔离会话。

```bash
npm run cli -- answer --run-id <run-id> \
  --text "比较不同 category 的主题占比及时间变化"
npm run cli -- columns --run-id <run-id> \
  --text "text 是正文，created_at 是时间，id 是标识符"
```

### `status`

读取规范工作流投影，不推进 Run：

```bash
npm run cli -- status --run-id <run-id>
npm run cli -- status --run-id <run-id> --json
```

### `plan show` 与 Run 级 `plan approve`

查看候选/正式计划，或审批正在等待 `HumanPlanReview` 的 Run。带 `--run-id` 时进入 Run 级命令，与带 `--plan-id` 的底层兼容命令不同。

```bash
npm run cli -- plan show --run-id <run-id>
npm run cli -- plan approve --run-id <run-id> --approved-by local_user
```

### `train status` 与 `train cancel`

Agent 层的训练状态和取消别名。`--log-limit` 为不超过 500 的正整数；取消不带 `--approve` 时只预览。

```bash
npm run cli -- train status --run-id <training-run-id> --log-limit 100
npm run cli -- train cancel --run-id <training-run-id> --reason "输入错误"
npm run cli -- train cancel --run-id <training-run-id> --reason "输入错误" --approve
```

### `repl`

打开持久化对话 Agent，也可以附着到现有 Run 或指定其他数据库：

```bash
npm run cli -- repl
npm run cli -- repl --run-id <run-id>
npm run cli -- repl --run-id <run-id> --runtime-db .theta_agent/custom.sqlite
```

## 数据集与模型工具命令

### `dataset inspect`

读取格式、编码、行列和受限样本，但不注册数据：

```bash
npm run cli -- dataset inspect --file fixtures/sample.jsonl --sample-size 5
```

### `dataset detect-columns`

评估正文、时间、ID 与元数据候选列：

```bash
npm run cli -- dataset detect-columns --file fixtures/sample.jsonl --sample-size 10
```

### `dataset register`

在本地 Registry 中注册允许访问的数据文件并返回 `datasetRef`：

```bash
npm run cli -- dataset register --file fixtures/sample.jsonl --json
```

### `dataset explore`

只能探索已经注册的引用，请使用上一条命令返回的 `datasetRef`：

```bash
npm run cli -- dataset explore --dataset-ref <dataset-ref> --sample-size 5
```

### `dataset understanding`

读取某个 Run 已校验的 V2 数据理解：

```bash
npm run cli -- dataset understanding --run-id <run-id> --json
```

### `dataset confirm`

根据实际观测到的列校验确认内容，并恢复同一个 Run：

```bash
npm run cli -- dataset confirm --run-id <run-id> \
  --file fixtures/cli/dataset-confirmation.json
```

### `models`

通过受治理 Tool Registry 查看 THETA 模型目录：

```bash
npm run cli -- models
npm run cli -- models --json
```

### `recommend`

根据标准化 Profile 和已确认的列运行确定性推荐器，`--max-topics` 必须是正整数：

```bash
npm run cli -- recommend \
  --profile fixtures/data-profile.json \
  --columns fixtures/model-recommend-columns.json \
  --goal "发现可解释主题" --max-topics 12
```

## 底层计划与训练命令

这些命令直接暴露受治理 Tool 契约。实际研究优先使用 REPL，因为它会按正确顺序生成哈希绑定记录和审批回执。

### `plan validate`

验证 Planner V2 bundle 中的 `validatedPlan`，不写入状态：

```bash
npm run cli -- plan validate --file <planner-v2-bundle.json>
```

### `plan create`

不带 `--approve` 只申请审批，审查后带参数重复执行。输入必须包含同一工作流的 validated plan、facts、confirmation、intent、planner input/decision、evidence bundle、validation 和 DomainPack 信息。

```bash
npm run cli -- plan create --file <planner-v2-bundle.json>
npm run cli -- plan create --file <planner-v2-bundle.json> --approve
```

### 底层 `plan approve`

带 `--plan-id` 时进入兼容命令。ID 和 hash 必须来自同一次 `plan create`：

```bash
npm run cli -- plan approve \
  --plan-id <plan-id> --plan-hash <plan-hash> \
  --approved-by local_user --note "已审查" --approve
```

### `training dry-run`

输入字段是 `plan`、`planReview` 和 `datasetPath`。它校验完整绑定，但绝不启动训练：

```bash
npm run cli -- training dry-run --file <dry-run-request.json>
```

### `training start`

输入字段是 `plan`、`planReview`、`dryRun`、`trainingReview` 和可选 `idempotencyKey`。不带 `--approve` 只预览；所有记录必须属于同一 plan/hash 链。

```bash
npm run cli -- training start --file <training-start-request.json>
npm run cli -- training start --file <training-start-request.json> --approve
```

### `training status` 与 `training cancel`

这是 Agent 别名对应的直接 Tool 形式：

```bash
npm run cli -- training status --run-id <training-run-id> --log-limit 100
npm run cli -- training cancel --run-id <training-run-id> --reason "请求停止"
npm run cli -- training cancel --run-id <training-run-id> --reason "请求停止" --approve
```

仓库刻意不提供静态 plan/dry-run/start 回执：其中的哈希和审批 ID 对其他 Run 无效。详情见 `fixtures/cli/README.md`。

## 工作流契约命令

### `workflow compile`

编译 DomainPack，并显示 FSM、Tool 引用和契约哈希：

```bash
npm run cli -- workflow compile
```

### `workflow run`

`start` 的显式形式，默认 V2。可使用 `--file` 或 `--input`、`--goal`、`--sample-size`、`--planner-mode provider|deterministic`、`--run-id`、`--runtime-db`、`--approve-plans`、`--approve-training`、`--approved-by` 和 `--json`。

```bash
npm run cli -- workflow run --input fixtures/cli/workflow-input.json
npm run cli -- workflow run --file fixtures/sample.jsonl \
  --planner-mode deterministic --json
```

### `workflow resume`

根据当前等待状态提交一个适用输入。可用参数包括 `--answers`、`--columns`、`--dataset-confirmation`、`--decision-answer`、`--plan-adjustment`、`--approve` 和 `--reject`。

```bash
npm run cli -- workflow resume --run-id <run-id> \
  --dataset-confirmation fixtures/cli/dataset-confirmation.json
npm run cli -- workflow resume --run-id <run-id> \
  --decision-answer "使用中等主题粒度"
npm run cli -- workflow resume --run-id <run-id> \
  --plan-adjustment fixtures/cli/plan-adjustment.json
npm run cli -- workflow resume --run-id <run-id> --approve
```

### `workflow status`、`workflow trace` 与 `workflow replay`

status 读取投影，trace 导出规范事件与 Tool 事件，replay 在不调用供应商、不执行 Tool 的情况下构建确定性回放：

```bash
npm run cli -- workflow status --run-id <run-id>
npm run cli -- workflow trace --run-id <run-id> --json
npm run cli -- workflow replay --run-id <run-id> --json
```

### `demo`

运行本地治理演示，永远不会启动训练；不带 `--approve` 时停在计划审批预览：

```bash
npm run cli -- demo
npm run cli -- demo --approve
```

## REPL 全部交互命令

不以 `/` 开头的文本会根据当前工作流状态进行自然语言路由；Slash 指令是确定性控制。

| 指令 | 用途与示例 |
| --- | --- |
| `/help` | 显示内置指令摘要。 |
| `/start <file>` | 创建并激活 Run：`/start fixtures/sample.jsonl`。 |
| `/answer <text>` | 显式回答：`/answer 比较不同类别的时间变化`。 |
| `/columns <text>` | 确认列：`/columns text 是正文；created_at 是时间`。 |
| `/llm on\|off` | 授予或撤销当前会话的供应商辅助权限。 |
| `/model` | 显示当前供应商和模型。 |
| `/model list` | 显示全部供应商及配置状态。 |
| `/model use <provider> <model>` | 保存模型：`/model use deepseek deepseek-v4-pro`。 |
| `/model reset` | 恢复 `.env` 默认模型。 |
| `/brief` | 查看当前持久化研究档案。 |
| `/history` | 查看最近的持久化对话。 |
| `/next` | 查看推荐的下一步。 |
| `/done` | 使用已校验或默认回答结束当前研究访谈。 |
| `/details [section] [page]` | 分页查看上一响应：`/details evidence 2`。 |
| `/status [runId]` | 查看活动或指定 Run 状态。 |
| `/why [all\|model\|parameters\|protocol\|evidence] [runId]` | 解释决策：`/why model`。 |
| `/evidence [runId]` | 查看治理证据。 |
| `/plan [runId]` | 查看候选或正式计划。 |
| `/approve-plan [runId]` | 审批 1/2，生成正式计划。 |
| `/approve-plan --accept-degradation` | 明确接受已报告的能力降级。 |
| `/start-training [runId]` | 审批 2/2，启动绑定的训练执行。 |
| `/approve [runId]` | 当前等待状态的兼容审批。 |
| `/adjust <text>` | 调整计划：`/adjust 使用 8 个主题并只用 CPU`。 |
| `/follow` | 跟踪训练至终态；Ctrl-C 只会停止跟踪。 |
| `/logs` | 查看近期训练日志。 |
| `/results` | 列出已验证的结果产物。 |
| `/open-results` | 打开活动 Run 的本地结果目录。 |
| `/summary` | 解读落盘指标和产物。 |
| `/runs` | 列出本地持久化 Run。 |
| `/cancel <reason>` | 预览取消。 |
| `/cancel <reason> --confirm` | 确认取消活动训练。 |
| `/retry` | 恢复失败 Run 或建立绑定的重试执行。 |
| `/reevaluate` | 不重新训练，直接重新计算现有产物质量。 |
| `/save [runId]` | 生成确定性 Replay。 |
| `/back` | 清除活动 Run，但不删除持久化数据。 |
| `/exit` | 关闭 REPL。 |

## 退出码与排错

- `0`：命令完成，或成功返回非阻断的审批预览。
- `1`：参数错误、输入缺失、策略/Tool 错误或未知命令。
- `2`：Doctor 发现阻断问题、工作流失败，或计划校验被拒绝。

常用检查：

```bash
npm run deps:ensure
npm run build
npm run doctor
npm run test:docs
```

如果出现 `node:sqlite` 不可用，请执行 `nvm use`；系统要求 Node 22.5 或更高版本。供应商配置不完整时，检查 `.env` 并运行 `npm run cli -- model list`。禁止提交 `.env`、`.theta_agent/`、数据集、上游源码或训练产物。
