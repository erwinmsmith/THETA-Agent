import {
  resolveThetaComputeProfile,
  type ThetaComputeProfile,
} from '@theta-agent/tools/compute-policy.js';
import { bootstrapResearchAgent } from './bootstrap.js';
import {
  buildThetaWorkspaceInteraction,
  type ThetaAgentInteraction,
} from './interaction-service.js';

export interface ThetaRuntimeProfile {
  service: 'theta-agent-runtime';
  version: 'v2';
  compute: ThetaComputeProfile;
  capabilities: {
    domains: number;
    tools: number;
    skills: number;
  };
  entryInteraction: ThetaAgentInteraction;
}

/** Return safe, credential-free runtime capabilities for adapters and UIs. */
export const getThetaRuntimeProfile = async (): Promise<ThetaRuntimeProfile> => {
  const registries = await bootstrapResearchAgent();
  return {
    service: 'theta-agent-runtime',
    version: 'v2',
    compute: resolveThetaComputeProfile(),
    capabilities: {
      domains: registries.domains.list().length,
      tools: registries.tools.list().length,
      skills: registries.skills.list().length,
    },
    entryInteraction: buildThetaWorkspaceInteraction(),
  };
};
