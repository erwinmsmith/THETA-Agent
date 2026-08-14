import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalSkillLoader,
  resolveBuiltinSkillsDirectory,
  SkillRegistry,
  type SkillSpec,
} from "@codesoul-co/hypha-skills";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const resolveRepositoryRoot = (): string =>
  path.resolve(
    process.env.THETA_AGENT_REPOSITORY_ROOT ??
      path.join(moduleDirectory, "..", "..", ".."),
  );

export interface AgentSkillRegistryResult {
  registry: SkillRegistry;
  skills: SkillSpec[];
  directories: string[];
}

export const createAgentSkillRegistry = async (
  repositoryRoot = resolveRepositoryRoot(),
): Promise<AgentSkillRegistryResult> => {
  const directories = [
    path.join(repositoryRoot, "skills"),
    resolveBuiltinSkillsDirectory(),
  ];
  const registry = new SkillRegistry();
  const loader = new LocalSkillLoader({ directories, recursive: true });
  const skills = await loader.loadInto(registry);
  assertUniqueSkillVersions(skills);
  return { registry, skills, directories };
};

const assertUniqueSkillVersions = (skills: readonly SkillSpec[]): void => {
  const identities = new Set<string>();
  for (const skill of skills) {
    const identity = `${skill.id}@${skill.version}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate Skill registration: ${identity}`);
    }
    identities.add(identity);
  }
};
