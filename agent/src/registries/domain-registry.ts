import { DomainPackRegistry, type DomainPackSpec } from "@codesoul-co/hypha-domain";
import {
  createResearchAgentDomainPack,
  THETA_DOMAIN_PACK_ID,
  THETA_DOMAIN_PACK_VERSION,
} from "@theta-agent/domain/domain.js";
import type { ToolSpec } from "@codesoul-co/hypha-tools";

export interface AgentDomainRegistryResult {
  registry: DomainPackRegistry;
  domain: DomainPackSpec;
}

export const createAgentDomainRegistry = (
  tools: readonly ToolSpec[],
): AgentDomainRegistryResult => {
  const registry = new DomainPackRegistry();
  const domain = registry.register(
    createResearchAgentDomainPack(tools),
    "domain/research-agent.domain",
  );
  const resolved = registry.get(THETA_DOMAIN_PACK_ID, THETA_DOMAIN_PACK_VERSION);
  if (!resolved) {
    throw new Error("Research Agent Domain registration failed.");
  }
  return { registry, domain };
};
