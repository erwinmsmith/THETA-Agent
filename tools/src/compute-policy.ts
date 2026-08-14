export type ThetaComputeDevice = 'cpu' | 'gpu';
export type ThetaExecutionBackend = 'local';

export interface ThetaComputeProfile {
  backend: ThetaExecutionBackend;
  defaultDevice: ThetaComputeDevice;
  scheduler: {
    supported: false;
    enabled: false;
  };
}

/**
 * Resolve the process-wide compute policy. Local CPU execution is the safe
 * product default; the backend field is the stable boundary for a future
 * scheduler implementation.
 */
export const resolveThetaComputeProfile = (
  env: NodeJS.ProcessEnv = process.env,
): ThetaComputeProfile => {
  const backend = normalized(env.THETA_COMPUTE_BACKEND) || 'local';
  if (backend !== 'local') {
    throw new Error(
      `Unsupported THETA_COMPUTE_BACKEND "${backend}". Only "local" is available.`,
    );
  }

  const defaultDevice = normalized(env.THETA_COMPUTE_DEVICE) || 'cpu';
  if (defaultDevice !== 'cpu' && defaultDevice !== 'gpu') {
    throw new Error(
      `Unsupported THETA_COMPUTE_DEVICE "${defaultDevice}". Use "cpu" or "gpu".`,
    );
  }

  return {
    backend,
    defaultDevice,
    scheduler: { supported: false, enabled: false },
  };
};

export const resolveThetaComputeDevice = (
  requested: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ThetaComputeDevice =>
  requested === 'cpu' || requested === 'gpu'
    ? requested
    : resolveThetaComputeProfile(env).defaultDevice;

const normalized = (value: string | undefined): string =>
  value?.trim().toLowerCase() ?? '';
