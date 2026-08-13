import { runThetaRagBuild } from '@theta-agent/tools/hypha-runner.js';

const result = await runThetaRagBuild();
if (result.status !== 'completed' || result.output === undefined) {
  throw new Error(
    `RAG index build failed: ${JSON.stringify(result.error ?? result.status)}`,
  );
}
console.log(JSON.stringify(result.output));
