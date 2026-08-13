export {
  THETA_PERMISSION_SCOPES,
  THETA_TOOL_IDS,
} from "@theta-agent/domain/domain.js";

import { THETA_TOOL_IDS } from "@theta-agent/domain/domain.js";

export type ThetaToolId =
  (typeof THETA_TOOL_IDS)[keyof typeof THETA_TOOL_IDS];
