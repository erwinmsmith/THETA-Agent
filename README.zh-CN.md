# THETA Agent

[English](README.md) | 简体中文

THETA Agent 是一个以 Agent 为核心、面向命令行的对话式自动研究系统。它帮助研究人员理解数据集、明确研究问题、选择有证据支持的模型、审查可执行计划、批准高成本操作、监控训练过程，并解读最终产物。

THETA 主题建模是系统首个研究能力，但不是产品的架构边界。仓库经过分层设计，使未来的研究能力可以复用对话、规划、治理、工具、记忆和运行时层，而不必与 THETA 的特定模型代码耦合。

## 设计原则

- **Agent 优先：** 对话和研究编排是产品的核心。
- **领域适配：** THETA 是第一个可插拔研究能力。
- **受控执行：** 所有外部操作都必须完成注册、权限控制和审计，并在必要时要求明确的人工批准。
- **依赖可复现：** 上游仓库固定到 `config/upstreams.lock.json` 中经过审查的提交。
- **所有权清晰：** 上游源码只存放在被忽略的 `third_party/` 目录中，绝不会提交到本仓库。
- **默认本地运行：** 数据集、模型资源、凭据和运行产物均保留在版本控制之外。

## 仓库结构

```text
agent/                       Agent 编排、运行时、记忆和应用服务
domain/                      研究契约和工作流规范
tools/                       已注册工具和 THETA Python 适配器
skills/                      项目自身的 Agent Skills
knowledge/                   证据清单和模型能力卡
apps/cli/                    仅包含终端适配层
apps/api/                    仅包含 HTTP 适配层
config/                      经审查的上游依赖版本
third_party/                 被忽略的本地 THETA 和 Hypha 检出
```

Hypha 是系统唯一的基础框架。Agent 启动器直接从 `third_party/Hypha` 加载 Hypha 内置 Skills，从 `skills/` 加载项目 Skills，从 `tools/` 注册受控工具，并验证这些注册是否满足领域工作流。THETA 只通过这些工具调用，其源码不会复制到项目代码中。

## 环境要求

- Git
- Node.js 22.5 或更高版本
- 通过 Corepack 使用 pnpm
- uv 0.11 或更高版本；Python 3.12 环境由 uv 管理

## 快速开始

### 1. 克隆 THETA Agent

```bash
git clone https://github.com/erwinmsmith/THETA-Agent.git
cd THETA-Agent
```

### 2. 准备 THETA 和 Hypha

仓库会在执行 `npm run doctor` 和 `npm start` 前自动检查两个上游依赖。如果缺少任意检出，`deps:ensure` 会把其配置的 `main` 分支最新提交克隆到被忽略的 `third_party/` 目录中。同一个命令还会报告本地提交是否与已审查的固定版本一致。已有检出不会被自动拉取或覆盖：

```bash
npm run deps:ensure
```

需要严格复现 `config/upstreams.lock.json` 中记录的版本时，使用：

```bash
npm run deps:sync
```

如果希望手动克隆上游仓库，请使用以下固定路径，然后执行依赖检查：

```bash
mkdir -p third_party
git clone --filter=blob:none --branch main \
  https://github.com/CodeSoul-co/THETA.git third_party/THETA
git clone --filter=blob:none --branch main \
  https://github.com/CodeSoul-co/Hypha.git third_party/Hypha
npm run deps:ensure
```

`third_party/` 已被刻意忽略。不要把 THETA 或 Hypha 源码添加到本仓库。

### 3. 安装依赖

安装默认本地运行环境：

```bash
corepack enable
npm run python:sync
npm run hypha:install
npm run hypha:build
pnpm install --frozen-lockfile
npm run build
npm run test:registries
```

如果使用 nvm，请先运行 `nvm use`；`.nvmrc` 会选择已经验证的 Node.js 版本。

默认 uv 环境支持 THETA 工具、数据检查、测试和模型目录。仅在需要执行训练时安装完整的 THETA 训练依赖：

```bash
npm run python:sync:training
```

CLI 会自动使用 `.venv/bin/python`，Windows 则使用对应的虚拟环境解释器。

### 4. 配置并切换语言模型

确定性 Agent 不需要 API Key 也能运行。DeepSeek 是默认语言模型供应商；可选语言模型层还支持 MiniMax、OpenAI、OpenRouter、本地 Ollama，以及任意 OpenAI-compatible 接口。创建本地环境文件，只需填写一个供应商的必需配置：

```bash
cp .env.example .env
```

如果同级 Hypha 工作副本已有 DeepSeek Key，可以在不显示密钥的情况下只导入 DeepSeek 配置：

```bash
npm run env:import:hypha
```

`.env` 已被忽略，禁止提交到版本控制。

可以在 `.env` 中设置 `THETA_LLM_PROVIDER` 和 `THETA_LLM_MODEL` 作为环境默认值，也可以不修改文件直接切换：

```bash
npm run build
npm run model -- list
npm run model -- use --provider openai --model <model-id>
npm run model -- current
```

当前供应商和模型会保存到已忽略的 `.theta_agent/inference-selection.json`，API Key 仍然只保留在 `.env` 中。已保存的选择优先级高于 `THETA_LLM_PROVIDER`；清除后会恢复环境默认值：

```bash
npm run model -- reset
```

在交互式 Agent 内，对应命令是 `/model list`、`/model use <provider> <model>`、`/model` 和 `/model reset`。`/llm on` 用于开启当前会话的语言辅助；模型选择与会话授权是两个独立控制。

各供应商的环境变量说明见 [.env.example](.env.example)。Ollama 通常只需设置 `OLLAMA_MODEL`；其他内置远程供应商需要对应的 API Key。`npm run doctor` 会报告当前选择及其配置是否可用。

### 5. 验证并启动系统

检查完整的本地 Agent 环境：

```bash
npm run doctor
```

启动对话式研究 Agent：

```bash
npm start
```

启动可选的本地 HTTP API：

```bash
npm run start:api
```

首次会话示例：

```text
/start fixtures/sample.jsonl
/next
/brief
/exit
```

所有直接 CLI 和交互式指令的参数、审批行为、完整案例、退出码与排错方法，请查看 [CLI 中文完整手册](docs/CLI.zh-CN.md)；同时也提供 [English CLI reference](docs/CLI.md)。

## 更新上游依赖

确保两个检出均存在，并查看本地版本与固定版本状态：

```bash
npm run deps:ensure
```

获取当前 `main` 分支、把本地检出移动到最新提交，并更新待审查的锁定文件：

```bash
npm run deps:update
```

提交前请审查并测试 `config/upstreams.lock.json` 的变化。其他开发者随后可以通过 `npm run deps:sync` 复现完全相同的版本。

完整的开发和架构约定请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可证

项目自主编写的代码使用 [MIT License](LICENSE)。本地下载的 THETA 和 Hypha 源码分别遵循其上游许可证。
