import { bootstrapResearchAgent } from '../agent/dist/bootstrap.js';

const boot = await bootstrapResearchAgent();
const tools = boot.tools.list();
const skills = boot.skills.list();
const domains = boot.domains.list();

if (tools.length === 0) throw new Error('No tools were registered.');
if (skills.length === 0) throw new Error('No skills were registered.');
if (domains.length !== 1) {
  throw new Error(`Expected one domain registration, received ${domains.length}.`);
}

console.log(
  `PASS Registries loaded ${tools.length} tools, ${skills.length} skills, and ${domains.length} domain.`,
);
