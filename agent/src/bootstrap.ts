import { compileResearchAgentDomain } from "@theta-agent/domain/domain.js";
import {
  createAgentToolRegistry,
  thetaHyphaToolSpecs,
} from "@theta-agent/tools/registry/tool-registry.js";
import { createAgentDomainRegistry } from "./registries/domain-registry.js";
import { createAgentSkillRegistry } from "./registries/skill-registry.js";

export const bootstrapResearchAgent = async () => {
  const tools = createAgentToolRegistry();
  const skills = await createAgentSkillRegistry();
  const domains = createAgentDomainRegistry(thetaHyphaToolSpecs);

  for (const skillRef of domains.domain.allowedSkills ?? []) {
    const skill = skills.registry.get(skillRef.id);
    if (!skill || (skillRef.version && skill.version !== skillRef.version)) {
      throw new Error(
        `Domain requires an unregistered Skill: ${skillRef.id}@${skillRef.version ?? "latest"}`,
      );
    }
  }
  for (const toolSpec of domains.domain.tools ?? []) {
    if (!tools.resolve({ id: toolSpec.id, version: toolSpec.version })) {
      throw new Error(
        `Domain requires an unregistered Tool: ${toolSpec.id}@${toolSpec.version}`,
      );
    }
  }

  return {
    tools,
    skills: skills.registry,
    domains: domains.registry,
    compilation: compileResearchAgentDomain(thetaHyphaToolSpecs),
  };
};
