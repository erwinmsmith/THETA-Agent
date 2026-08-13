import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { ThetaWorkflowService } from './theta-workflow-service.js';
import { createThetaWorkflowRuntime } from './runtime/hypha-runtime.js';
import { runThetaModelCatalog } from '@theta-agent/tools/hypha-runner.js';
import {
  createInferenceProviderFromEnv,
  listInferenceProviders,
  resolveInferenceSelection,
} from '@theta-agent/tools/support/providers/registry.js';
import { probeThetaPythonModules } from '@theta-agent/tools/theta-tools.js';
import { CapabilityRegistry } from '@theta-agent/tools/support/capabilities/registry.js';
import { getKnowledgeIndexStatus } from '@theta-agent/tools/support/rag/service.js';
import {
  hyphaUpstreamRoot,
  repositoryRoot,
  thetaUpstreamRoot,
  upstreamLockPath,
} from '@theta-agent/tools/support/repository-paths.js';

export type DoctorCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorReport {
  status: 'ready' | 'degraded' | 'blocked';
  checkedAt: string;
  checks: DoctorCheck[];
}

export interface DoctorServiceOptions {
  agentRoot?: string;
  now?: () => string;
}

export class DoctorService {
  private readonly agentRoot: string;
  private readonly projectRoot: string;
  private readonly now: () => string;

  constructor(options: DoctorServiceOptions = {}) {
    this.agentRoot = path.resolve(options.agentRoot ?? repositoryRoot);
    this.projectRoot = repositoryRoot;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async run(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    checks.push(nodeCheck());
    checks.push(await this.pnpmCheck());
    checks.push(await this.hyphaLockCheck());
    checks.push(await this.hyphaBuildCheck());
    checks.push(this.domainPackCheck());
    checks.push(await this.runtimeCheck());
    checks.push(await this.artifactRootCheck());
    checks.push(await this.dataRootsCheck());
    checks.push(await this.thetaConfigCheck());
    checks.push(this.pythonRuntimeCheck());
    checks.push(await this.pythonAndModelCheck());
    checks.push(await this.capabilityRegistryCheck());
    checks.push(await this.structuredKnowledgeCheck());
    checks.push(gpuCheck());
    checks.push(inferenceProviderCheck());

    return {
      status: checks.some((check) => check.status === 'FAIL')
        ? 'blocked'
        : checks.some((check) => check.status === 'WARN')
          ? 'degraded'
          : 'ready',
      checkedAt: this.now(),
      checks,
    };
  }

  private async pnpmCheck(): Promise<DoctorCheck> {
    const workspace = path.join(this.agentRoot, 'pnpm-workspace.yaml');
    const lock = path.join(this.agentRoot, 'pnpm-lock.yaml');
    return (await exists(workspace)) && (await exists(lock))
      ? pass('pnpm.workspace', 'pnpm workspace and lockfile are present.')
      : fail(
          'pnpm.workspace',
          'pnpm workspace metadata is incomplete.',
          'Run pnpm install at the repository root and commit pnpm-lock.yaml.',
        );
  }

  private async hyphaLockCheck(): Promise<DoctorCheck> {
    try {
      const lock = JSON.parse(await readFile(upstreamLockPath, 'utf8')) as {
        dependencies?: {
          hypha?: { branch?: unknown; revision?: unknown };
        };
      };
      const hypha = lock.dependencies?.hypha;
      if (
        typeof hypha?.branch !== 'string' ||
        typeof hypha.revision !== 'string' ||
        !/^[0-9a-f]{40}$/i.test(hypha.revision)
      ) {
        throw new Error('branch or 40-character commit is missing');
      }
      return pass(
        'hypha.lock',
        `Hypha is pinned to ${hypha.branch}@${hypha.revision.slice(0, 12)}.`,
      );
    } catch (error) {
      return fail(
        'hypha.lock',
        `Hypha lock is invalid: ${message(error)}`,
        'Restore config/upstreams.lock.json from the approved integration baseline.',
      );
    }
  }

  private async hyphaBuildCheck(): Promise<DoctorCheck> {
    const required = ['core', 'domain', 'fsm', 'tools', 'adapters-local', 'harness'];
    const missing: string[] = [];
    for (const name of required) {
      if (
        !(await exists(
          path.join(hyphaUpstreamRoot, 'packages', name, 'dist', 'index.js'),
        ))
      ) {
        missing.push(name);
      }
    }
    return missing.length === 0
      ? pass('hypha.build', 'All pinned Hypha package builds are available.')
      : fail(
          'hypha.build',
          `Missing built Hypha packages: ${missing.join(', ')}.`,
          'Run npm run hypha:build at the repository root.',
        );
  }

  private domainPackCheck(): DoctorCheck {
    try {
      const summary = new ThetaWorkflowService().compileSummary();
      return pass(
        'domain.pack',
        `Compiled ${String(summary.domainPack)} with ${String(summary.stateCount)} states.`,
      );
    } catch (error) {
      return fail(
        'domain.pack',
        `DomainPack compilation failed: ${message(error)}`,
        'Run npm run smoke:theta-domain and repair the DomainPack contract.',
      );
    }
  }

  private async runtimeCheck(): Promise<DoctorCheck> {
    const directory = path.join(this.agentRoot, '.theta_agent');
    const filename = path.join(directory, `doctor-${randomUUID()}.sqlite`);
    try {
      await mkdir(directory, { recursive: true });
      const runtime = await createThetaWorkflowRuntime({ filename });
      runtime.close();
      await cleanupSqlite(filename);
      return pass(
        'runtime.sqlite',
        `Runtime directory and SQLite adapters are writable at ${directory}.`,
      );
    } catch (error) {
      await cleanupSqlite(filename);
      return fail(
        'runtime.sqlite',
        `Runtime SQLite probe failed: ${message(error)}`,
        'Grant write permission to .theta_agent or set THETA_WORKFLOW_DB.',
      );
    }
  }

  private async artifactRootCheck(): Promise<DoctorCheck> {
    const root = path.resolve(
      process.env.THETA_AGENT_STATE_DIR ??
        path.join(this.projectRoot, '.theta_agent'),
      'runs',
    );
    try {
      await mkdir(root, { recursive: true });
      return pass('artifact.root', `Training artifact root is writable: ${root}.`);
    } catch (error) {
      return fail(
        'artifact.root',
        `Training artifact root is not writable: ${message(error)}`,
        'Set THETA_AGENT_STATE_DIR to a writable local directory.',
      );
    }
  }

  private async dataRootsCheck(): Promise<DoctorCheck> {
    const configured = process.env.THETA_ALLOWED_DATA_ROOTS;
    const roots = configured?.trim()
      ? configured
          .split(path.delimiter)
          .map((root) => path.resolve(root.trim()))
          .filter(Boolean)
      : [
          path.join(this.agentRoot, 'fixtures'),
          path.join(thetaUpstreamRoot, 'data'),
        ];
    const missing: string[] = [];
    for (const root of roots) {
      if (!(await exists(root))) missing.push(root);
    }
    return missing.length === 0
      ? pass('dataset.roots', `Allowed dataset roots: ${roots.join(', ')}.`)
      : fail(
          'dataset.roots',
          `Allowed dataset roots do not exist: ${missing.join(', ')}.`,
          'Create the directories or correct THETA_ALLOWED_DATA_ROOTS.',
        );
  }

  private async thetaConfigCheck(): Promise<DoctorCheck> {
    const config = path.join(
      thetaUpstreamRoot,
      'src',
      'models',
      'config.py',
    );
    return (await exists(config))
      ? pass('theta.config', `THETA model configuration found at ${config}.`)
      : fail(
          'theta.config',
          'THETA model configuration is missing.',
          'Run npm run deps:sync to restore the pinned THETA checkout.',
        );
  }

  private async pythonAndModelCheck(): Promise<DoctorCheck> {
    try {
      const result = await runThetaModelCatalog();
      const models = result.output?.models ?? [];
      if (result.status !== 'completed' || models.length === 0) {
        throw new Error(
          typeof result.error === 'string'
            ? result.error
            : (result.error?.message ?? `status=${result.status}`),
        );
      }
      return pass(
        'python.models',
        `Governed THETA tools loaded ${models.length} models.`,
      );
    } catch (error) {
      return fail(
        'python.models',
        `Governed Python/model probe failed: ${message(error)}`,
        'Verify THETA_AGENT_TOOLS_PYTHON, synchronize the uv environment, and run the check again.',
      );
    }
  }

  private async capabilityRegistryCheck(): Promise<DoctorCheck> {
    try {
      const result = await runThetaModelCatalog();
      const models = result.output?.models ?? [];
      if (result.status !== 'completed' || models.length === 0) {
        throw new Error(
          typeof result.error === 'string'
            ? result.error
            : (result.error?.message ?? `status=${result.status}`),
        );
      }
      const registry = new CapabilityRegistry({ agentRoot: this.agentRoot });
      const audit = registry.auditCatalog(models);
      if (audit.status === 'fail') {
        const failures = audit.issues
          .filter((issue) => issue.severity === 'error')
          .slice(0, 5)
          .map(
            (issue) =>
              `${issue.code}${issue.modelId ? `(${issue.modelId})` : ''}`,
          )
          .join(', ');
        return fail(
          'capability.registry',
          `Capability Registry 与 Catalog/CLI 发生漂移：${failures}。`,
          '修正 knowledge/capabilities/models 中的能力卡或对应实现；在审计通过前推荐入口会 fail-closed。',
        );
      }
      return pass(
        'capability.registry',
        `能力真相层已审计 ${audit.auditedModelIds.length} 个核心模型；Planner 可选 ${audit.plannerEligibleModelIds.length} 个（${audit.plannerEligibleModelIds.join(', ')}），安全排除 ${audit.plannerExcludedModelIds.length} 个。另有 ${audit.unauditedCatalogModelIds.length} 个 Catalog 模型尚未进入第一阶段审计。`,
      );
    } catch (error) {
      return fail(
        'capability.registry',
        `Capability Registry 加载失败：${message(error)}`,
        '检查 Capability Card YAML 结构、sourceRefs 与模型 Catalog，然后重新运行 doctor。',
      );
    }
  }

  private pythonRuntimeCheck(): DoctorCheck {
    const requiredModules = [
      'pandas',
      'numpy',
      'sklearn',
      'docx',
    ] as const;
    try {
      const probe = probeThetaPythonModules(requiredModules);
      const missing = requiredModules.filter((name) => !probe.modules[name]);
      if (missing.length > 0) {
        return fail(
          'python.runtime',
          `Python ${probe.executable} is missing training modules: ${missing.join(', ')}.`,
          'Run uv sync at the repository root, then run doctor again.',
        );
      }
      const optionalModules = ['pyarrow'];
      const optionalProbe = probeThetaPythonModules(optionalModules);
      const missingOptional = optionalModules.filter(
        (name) => !optionalProbe.modules[name],
      );
      if (missingOptional.length > 0) {
        return warn(
          'python.runtime',
          `Training will use ${probe.executable} (${probe.pythonEnvironment ?? 'unknown environment'}); optional modules are missing: ${missingOptional.join(', ')}. CSV training is unaffected.`,
          'Run uv sync at the repository root to install the locked environment.',
        );
      }
      return pass(
        'python.runtime',
        `Training will use ${probe.executable} (Python ${probe.version}, environment=${probe.pythonEnvironment ?? 'unknown'}).`,
      );
    } catch (error) {
      return fail(
        'python.runtime',
        `Could not validate the uv-managed Python runtime: ${message(error)}`,
        'Run uv sync at the repository root and retry.',
      );
    }
  }

  private async structuredKnowledgeCheck(): Promise<DoctorCheck> {
    try {
      const status = await getKnowledgeIndexStatus();
      if (status.status !== 'ready' || status.totalObjects === 0) {
        return warn(
          'knowledge.structured-v1',
          '结构化知识库尚未构建；推荐仍可使用确定性后备，但外部模型 Planner 缺少本地证据集。',
          'Run npm run rag:build at the repository root.',
        );
      }
      const requiredTypes = [
        'model', 'parameter', 'rule', 'recipe', 'evaluation_metric',
        'failure_mode', 'implementation_capability', 'project_constraint',
        'conflict_group',
      ];
      const missing = requiredTypes.filter((type) => !status.objectTypes[type]);
      if (missing.length) {
        return fail(
          'knowledge.structured-v1',
          `结构化知识库缺少对象类型：${missing.join(', ')}。`,
          'Fix knowledge/structured/v1.yaml and run npm run rag:build again.',
        );
      }
      return pass(
        'knowledge.structured-v1',
        `结构化知识库 V1 已就绪：${status.totalObjects} 个对象、${Object.keys(status.objectTypes).length} 种类型；多路 FTS 索引位于 ${status.database}。`,
      );
    } catch (error) {
      return fail(
        'knowledge.structured-v1',
        `结构化知识库状态不可读：${message(error)}`,
        'Run npm run rag:build again and inspect knowledge/manifest.yaml.',
      );
    }
  }
}

const nodeCheck = (): DoctorCheck => {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((value) => Number.parseInt(value, 10));
  return major > 22 || (major === 22 && minor >= 5)
    ? pass('node.version', `Node.js ${process.versions.node} is supported.`)
    : fail(
        'node.version',
        `Node.js ${process.versions.node} is below 22.5.`,
        'Install Node.js 22.5 or newer.',
      );
};

const gpuCheck = (): DoctorCheck => {
  const visible =
    process.env.CUDA_VISIBLE_DEVICES ?? process.env.NVIDIA_VISIBLE_DEVICES;
  return visible && visible !== '-1' && visible.toLowerCase() !== 'none'
    ? pass('gpu.visibility', `GPU visibility is configured as ${visible}.`)
    : warn(
        'gpu.visibility',
        'No explicit GPU visibility is configured; CPU-safe commands remain available.',
        'Set CUDA_VISIBLE_DEVICES when GPU training is required.',
      );
};

const inferenceProviderCheck = (): DoctorCheck => {
  try {
    const selection = resolveInferenceSelection();
    if (!selection) {
      return warn(
        'inference.provider',
        'No external inference provider is configured; deterministic operation is unaffected.',
        'Configure a provider in .env, then run theta model use --provider <id> --model <model>.',
      );
    }
    const provider = createInferenceProviderFromEnv();
    if (!provider) {
      const status = listInferenceProviders().find((item) => item.selected);
      return fail(
        'inference.provider',
        `Selected provider ${selection.providerId}/${selection.model} is missing credentials.`,
        `Configure the required key for ${status?.displayName ?? selection.providerId} without exposing it.`,
      );
    }
    return pass(
      'inference.provider',
      `Provider ${provider.id}/${provider.model} is selected for bounded language tasks and planning.`,
    );
  } catch (error) {
    return fail(
      'inference.provider',
      `Inference provider configuration is invalid: ${message(error)}`,
      'Correct the provider base URL, model, timeout, or API key without exposing secrets.',
    );
  }
};

const exists = async (filename: string): Promise<boolean> => {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
};

const cleanupSqlite = async (filename: string): Promise<void> => {
  await Promise.all(
    ['', '-shm', '-wal'].map((suffix) =>
      rm(`${filename}${suffix}`, { force: true }).catch(() => undefined),
    ),
  );
};

const pass = (id: string, text: string): DoctorCheck => ({
  id,
  status: 'PASS',
  message: text,
});

const warn = (
  id: string,
  text: string,
  remediation: string,
): DoctorCheck => ({
  id,
  status: 'WARN',
  message: text,
  remediation,
});

const fail = (
  id: string,
  text: string,
  remediation: string,
): DoctorCheck => ({
  id,
  status: 'FAIL',
  message: text,
  remediation,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
