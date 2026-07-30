import type { AdapterExecutionResult } from "@aaspai/contracts/harness";

export const COMPANY_ACTION_TOOL_SOURCE = `import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Submit a structured company hiring and delegation action to the AASPAI orchestrator.",
  args: {
    payload: tool.schema.string().max(65536).describe("JSON object containing an actions array"),
  },
  async execute({ payload }) {
    JSON.parse(payload);
    return "Company action submitted.";
  },
});
`;

const ROLES = new Set([
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "security",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "operator",
  "general",
]);

export interface HireAndDelegateAction {
  type: "hire_and_delegate";
  agentId: string;
  title: string;
  role:
    | "ceo"
    | "cto"
    | "cmo"
    | "cfo"
    | "security"
    | "engineer"
    | "designer"
    | "pm"
    | "qa"
    | "devops"
    | "researcher"
    | "operator"
    | "general";
  description: string;
  workTitle: string;
  workDescription: string;
  skillKeys?: string[];
  artifactPaths?: string[];
  citationPaths?: string[];
  commercialClaimPaths?: string[];
}

export function companyActions(result: AdapterExecutionResult): HireAndDelegateAction[] {
  const payload = result.resultJson;
  if (!Array.isArray(payload?.companyActions)) return [];
  if (payload.dryRun !== undefined) {
    return payload.dryRun === true ? parseCompanyActions(payload.companyActions) : [];
  }
  return payload.companyActions.flatMap((action) => companyActionPayload(action));
}

export function companyActionPayload(value: unknown): HireAndDelegateAction[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Company action payload must be an object");
  }
  const actions = (value as Record<string, unknown>).actions;
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 8) {
    throw new Error("Company action payload must contain 1-8 actions");
  }
  const parsed = parseCompanyActions(actions);
  if (parsed.length !== actions.length) throw new Error("Company action payload is invalid");
  return parsed;
}

export function requiresCommercialEvidence(
  action: Pick<HireAndDelegateAction, "role" | "workTitle" | "workDescription">,
): boolean {
  return (
    action.role === "cmo" ||
    /\b(?:lead|campaign|outreach|sales|prospect|deal)\b/i.test(
      `${action.workTitle} ${action.workDescription}`,
    )
  );
}

function parseCompanyActions(values: unknown[]): HireAndDelegateAction[] {
  const actions: HireAndDelegateAction[] = [];
  for (const action of values) {
    if (isHireAndDelegateAction(action)) actions.push(action);
  }
  return actions;
}

function isHireAndDelegateAction(value: unknown): value is HireAndDelegateAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  const pathLists = ["artifactPaths", "citationPaths", "commercialClaimPaths"] as const;
  const commercialEvidenceRequired =
    typeof action.role === "string" &&
    typeof action.workTitle === "string" &&
    typeof action.workDescription === "string" &&
    requiresCommercialEvidence({
      role: action.role as HireAndDelegateAction["role"],
      workTitle: action.workTitle,
      workDescription: action.workDescription,
    });
  return (
    action.type === "hire_and_delegate" &&
    typeof action.agentId === "string" &&
    /^agent\/[a-z0-9][a-z0-9-]{1,63}$/.test(action.agentId) &&
    action.agentId !== "agent/ceo" &&
    typeof action.title === "string" &&
    action.title.trim().length > 0 &&
    action.title.length <= 128 &&
    typeof action.role === "string" &&
    ROLES.has(action.role) &&
    typeof action.description === "string" &&
    action.description.trim().length > 0 &&
    action.description.length <= 2_000 &&
    typeof action.workTitle === "string" &&
    action.workTitle.trim().length > 0 &&
    action.workTitle.length <= 512 &&
    typeof action.workDescription === "string" &&
    action.workDescription.trim().length > 0 &&
    action.workDescription.length <= 16_384 &&
    (action.skillKeys === undefined ||
      (Array.isArray(action.skillKeys) &&
        action.skillKeys.length <= 16 &&
        action.skillKeys.every(
          (key) => typeof key === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(key),
        ))) &&
    pathLists.every((key) => {
      const paths = action[key];
      return (
        paths === undefined ||
        (Array.isArray(paths) &&
          paths.length <= 32 &&
          paths.every(
            (path) =>
              typeof path === "string" &&
              path.length > 0 &&
              path.length <= 8_192 &&
              !path.startsWith("/") &&
              !path.startsWith("\\") &&
              !path.split(/[\\/]/).includes(".."),
          ))
      );
    }) &&
    (!commercialEvidenceRequired ||
      (Array.isArray(action.citationPaths) &&
        action.citationPaths.length > 0 &&
        Array.isArray(action.commercialClaimPaths) &&
        action.commercialClaimPaths.length > 0))
  );
}
