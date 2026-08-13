import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  repositoryRoot,
  uvPythonExecutable,
} from '../repository-paths.js';

export interface ThetaPythonRuntime {
  executable: string;
  version: string;
  prefix: string;
  pythonEnvironment: string | null;
}

export interface ThetaPythonProbe extends ThetaPythonRuntime {
  modules: Record<string, boolean>;
}

export interface BridgeCallContext {
  runId: string;
  stepId: string;
}

export interface BridgeResponse {
  status: 'ok' | 'error';
  protocol?: string;
  command?: string;
  data?: unknown;
  error?: {
    type?: string;
    message?: string;
  };
}

const bridgeRoot = (): string => {
  return resolve(repositoryRoot, 'packages');
};

const runtimeProbe = [
  'import json, os, sys',
  'print(json.dumps({',
  '  "executable": sys.executable,',
  '  "version": ".".join(map(str, sys.version_info[:3])),',
  '  "prefix": sys.prefix,',
  '  "pythonEnvironment": os.environ.get("VIRTUAL_ENV") or sys.prefix',
  '}))',
].join('\n');

export const resolveThetaPythonRuntime = (): ThetaPythonRuntime => {
  const requested =
    process.env.THETA_AGENT_PYTHON?.trim() ||
    process.env.THETA_AGENT_BRIDGE_PYTHON?.trim() ||
    uvPythonExecutable;
  const result = spawnSync(requested, ['-c', runtimeProbe], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  if (result.error) {
    throw new Error(
      `无法启动 THETA Python（${requested}）：${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `THETA Python 探测失败（${requested}）：${String(result.stderr || result.stdout).trim()}`,
    );
  }
  const parsed = JSON.parse(
    String(result.stdout).trim(),
  ) as Partial<ThetaPythonRuntime>;
  if (!parsed.executable || !isAbsolute(parsed.executable)) {
    throw new Error(
      `Python 未返回有效的绝对解释器路径：${String(parsed.executable)}`,
    );
  }
  return {
    executable: resolve(parsed.executable),
    version: String(parsed.version ?? ''),
    prefix: resolve(
      String(parsed.prefix ?? dirname(parsed.executable)),
    ),
    pythonEnvironment:
      typeof parsed.pythonEnvironment === 'string' &&
      parsed.pythonEnvironment.trim()
        ? parsed.pythonEnvironment.trim()
        : null,
  };
};

export const probeThetaPythonModules = (
  modules: readonly string[],
): ThetaPythonProbe => {
  const runtime = resolveThetaPythonRuntime();
  const moduleProbe = [
    'import importlib.util, json, os, sys',
    `modules = ${JSON.stringify(modules)}`,
    'print(json.dumps({',
    '  "executable": sys.executable,',
    '  "version": ".".join(map(str, sys.version_info[:3])),',
    '  "prefix": sys.prefix,',
  '  "pythonEnvironment": os.environ.get("VIRTUAL_ENV") or sys.prefix,',
    '  "modules": {name: importlib.util.find_spec(name) is not None for name in modules}',
    '}))',
  ].join('\n');
  const result = spawnSync(runtime.executable, ['-c', moduleProbe], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout).trim());
  }
  const parsed = JSON.parse(String(result.stdout).trim()) as {
    modules?: Record<string, boolean>;
  };
  return {
    ...runtime,
    modules: parsed.modules ?? {},
  };
};

const thetaPythonChildEnv = (
  runtime = resolveThetaPythonRuntime(),
): NodeJS.ProcessEnv => ({
  ...process.env,
  THETA_AGENT_PYTHON: runtime.executable,
  THETA_AGENT_BRIDGE_PYTHON: runtime.executable,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
});

export const callThetaBridge = async (
  command: string,
  input: unknown,
  context: BridgeCallContext,
): Promise<BridgeResponse> => {
  const cwd = bridgeRoot();
  let runtime;
  try {
    runtime = resolveThetaPythonRuntime();
  } catch (error) {
    return {
      status: 'error',
      command,
      error: {
        type: 'PythonRuntimeUnavailable',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const python = runtime.executable;
  const payload = JSON.stringify({
    command,
    input,
    context: {
      runId: context.runId,
      stepId: context.stepId
    }
  });

  return new Promise((resolvePromise) => {
    const child = spawn(python, ['-m', 'theta_agent_bridge'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...thetaPythonChildEnv(runtime),
        PYTHONPATH: [cwd, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(process.platform === 'win32' ? ';' : ':'),
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolvePromise({
        status: 'error',
        command,
        error: {
          type: error.name,
          message: error.message,
        },
      });
    });
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolvePromise({
          status: 'error',
          command,
          error: {
            type: 'EmptyBridgeResponse',
            message: stderr || `Bridge exited with code ${code}`,
          },
        });
        return;
      }

      try {
        resolvePromise(JSON.parse(trimmed) as BridgeResponse);
      } catch (error) {
        resolvePromise({
          status: 'error',
          command,
          error: {
            type: 'InvalidBridgeJson',
            message:
              error instanceof Error
                ? error.message
                : 'Bridge returned invalid JSON',
          },
          data: {
            stdout: trimmed,
            stderr,
          },
        });
      }
    });

    child.stdin.end(payload, 'utf8');
  });
};

export const openLocalFolder = (folderPath: string): void => {
  if (process.platform !== 'win32') {
    throw new Error('当前版本只支持在 Windows 中打开本地结果目录。');
  }
  const child = spawn('explorer.exe', [folderPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
};
