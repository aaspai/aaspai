import type { AdapterExecutionResult } from "@aaspai/contracts/harness";
import { type ProcessDefinition, processDefinitionSchema } from "@aaspai/contracts/operator";
import { type Trigger, triggerSchema } from "@aaspai/contracts/phase2";
import { nextScheduledOccurrence } from "@aaspai/loops";

export const COMPANY_ACTION_TOOL_SOURCE = `import { tool } from "@opencode-ai/plugin";

const organizationId = process.env.AASPAI_COMPANY_ORGANIZATION_ID || "default";
const createdAt = new Date().toISOString();

export default tool({
  description: [
    "Submit exactly one company action per call.",
    "hire_and_delegate roles: ceo, cto, cmo, cfo, security, engineer, designer, pm, qa, devops, researcher, operator, general. A project manager uses a domain role such as pm plus projectRole=manager.",
    'Valid manager hire (replace example IDs): {"actions":[{"type":"hire_and_delegate","agentId":"agent/project-manager","title":"Project Manager","role":"pm","description":"Owns one approved project.","workTitle":"Set up the approved project","workDescription":"Hire one immediately needed specialist, create one measurable milestone, and start one minimal process owned by that specialist.","projectId":"project/example","projectRole":"manager","skillKeys":["company-operator","company-work"]}]}',
    "Growth, lead, campaign, outreach, sales, prospect, or cmo work requires non-empty citationPaths and commercialClaimPaths, and every evidence path must also appear in artifactPaths.",
    "A new project manager must hire one immediately needed member before starting a process, then assign that already-hired specialist to every process step.",
    'For recurring operation set policy.schedule to {"kind":"interval","seconds":86400} or a valid cron schedule; the same manager session resumes at that cadence.',
    'create_milestone shape: {"actions":[{"type":"create_milestone","projectId":"project/example","title":"First outcome","outcome":"One evidence-backed result","sequence":1,"acceptance":{"results":1}}]}',
    'Valid minimal define_and_start_process (replace project/example and process/example-v1; agent/project-specialist must already be hired and assigned): {"actions":[{"type":"define_and_start_process","projectId":"project/example","milestoneSequence":1,"definition":{"id":"process/example-v1","organizationId":"' + organizationId + '","revision":1,"contentHash":"example-v1","name":"Minimal project loop","description":"Run one bounded evidence-backed cycle.","steps":[{"id":"step/execute","agent":"agent/project-specialist","dependsOn":[],"prompt":"Complete one bounded cycle and persist evidence.","skills":[],"tools":[],"workKind":"general","deliveryMode":"none","timeoutMs":86400000,"maxAttempts":3,"acceptanceCriteria":"One evidence-backed result is persisted.","failureAction":"escalate","approvalPolicy":{}}],"maxDurationMs":86400000,"maxAttempts":3,"createdAt":"' + createdAt + '"}}]}',
  ].join("\\n"),
  args: {
    payload: tool.schema.string().max(65536).describe('JSON object: {"actions":[...]}'),
  },
  async execute({ payload }, context) {
    JSON.parse(payload);
    const url = process.env.AASPAI_COMPANY_BROKER_URL;
    const token = process.env.AASPAI_COMPANY_BROKER_TOKEN;
    const organizationId = process.env.AASPAI_COMPANY_ORGANIZATION_ID;
    const attemptId = process.env.AASPAI_COMPANY_ATTEMPT_ID;
    const agentId = process.env.AASPAI_COMPANY_AGENT_ID;
    if (!url || !token || !organizationId || !attemptId || !agentId) {
      throw new Error("AASPAI company control broker is unavailable for this run");
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "x-aaspai-organization-id": organizationId,
        "x-aaspai-attempt-id": attemptId,
        "x-aaspai-agent-id": agentId,
        "x-aaspai-provider-session-id": context.sessionID,
      },
      body: payload,
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result?.message ?? result?.error ?? "Company action failed");
    }
    return JSON.stringify(result);
  },
});
`;

export const CODEX_COMPANY_ACTION_CLIENT_SOURCE = `const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = Buffer.concat(chunks).toString("utf8");
JSON.parse(payload);
const url = process.env.AASPAI_COMPANY_BROKER_URL;
const token = process.env.AASPAI_COMPANY_BROKER_TOKEN;
const organizationId = process.env.AASPAI_COMPANY_ORGANIZATION_ID;
const attemptId = process.env.AASPAI_COMPANY_ATTEMPT_ID;
const agentId = process.env.AASPAI_COMPANY_AGENT_ID;
if (!url || !token || !organizationId || !attemptId || !agentId) {
  throw new Error("AASPAI company control broker is unavailable for this run");
}
const response = await fetch(url, {
  method: "POST",
  headers: {
    authorization: "Bearer " + token,
    "content-type": "application/json",
    "x-aaspai-organization-id": organizationId,
    "x-aaspai-attempt-id": attemptId,
    "x-aaspai-agent-id": agentId,
  },
  body: payload,
});
const result = await response.json();
if (!response.ok) throw new Error(result?.message ?? result?.error ?? "Company action failed");
process.stdout.write(JSON.stringify(result));
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
  projectId?: string;
  projectRole?: "manager" | "member";
  skillKeys?: string[];
  artifactPaths?: string[];
  citationPaths?: string[];
  commercialClaimPaths?: string[];
}

export interface CreateMilestoneAction {
  type: "create_milestone";
  projectId: string;
  title: string;
  outcome: string;
  sequence: number;
  acceptance: Record<string, unknown>;
}

export interface DefineAndStartProcessAction {
  type: "define_and_start_process";
  projectId: string;
  milestoneSequence: number;
  definition: ProcessDefinition;
  loopId?: string;
  policy?: Record<string, unknown>;
}

export type CompanyAction =
  | HireAndDelegateAction
  | CreateMilestoneAction
  | DefineAndStartProcessAction;

export interface RequiredCompanyAction {
  type: CompanyAction["type"];
  projectId?: string;
}

export function requiredCompanyActionsForHire(
  action: Pick<HireAndDelegateAction, "projectRole">,
  projectId: string,
): RequiredCompanyAction[] {
  return action.projectRole === "manager"
    ? [
        { type: "hire_and_delegate", projectId },
        { type: "create_milestone", projectId },
        { type: "define_and_start_process", projectId },
      ]
    : [];
}

export function companyActions(result: AdapterExecutionResult): CompanyAction[] {
  const payload = result.resultJson;
  if (Array.isArray(payload?.companyActions)) {
    if (payload.dryRun !== undefined) {
      return payload.dryRun === true ? parseCompanyActions(payload.companyActions) : [];
    }
    return payload.companyActions.flatMap((action) => companyActionPayload(action));
  }
  const finalLine = result.summary?.trim().split(/\r?\n/).at(-1);
  const prefix = "AASPAI_COMPANY_ACTIONS=";
  if (!finalLine?.startsWith(prefix)) return [];
  return companyActionPayload(JSON.parse(finalLine.slice(prefix.length)));
}

export function missingRequiredCompanyActions(
  value: unknown,
  submitted: readonly CompanyAction[],
): RequiredCompanyAction[] {
  const required = Array.isArray(value)
    ? value.flatMap((item): RequiredCompanyAction[] => {
        if (typeof item === "string" && isCompanyActionType(item)) return [{ type: item }];
        if (!isRecord(item) || !isCompanyActionType(item.type)) return [];
        return [
          {
            type: item.type,
            ...(typeof item.projectId === "string" ? { projectId: item.projectId } : {}),
          },
        ];
      })
    : [];
  const available = [...submitted];
  return required.filter((requirement) => {
    const match = available.findIndex(
      (action) =>
        action.type === requirement.type &&
        (requirement.projectId === undefined ||
          ("projectId" in action && action.projectId === requirement.projectId)),
    );
    if (match < 0) return true;
    available.splice(match, 1);
    return false;
  });
}

export function companyActionPayload(value: unknown): CompanyAction[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Company action payload must be an object");
  }
  const actions = (value as Record<string, unknown>).actions;
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 8) {
    throw new Error("Company action payload must contain 1-8 actions");
  }
  const parsed = parseCompanyActions(actions);
  if (parsed.length !== actions.length) {
    const invalidIndex = actions.findIndex(
      (action) =>
        !isHireAndDelegateAction(action) &&
        !isCreateMilestoneAction(action) &&
        !isDefineAndStartProcessAction(action),
    );
    throw new Error(invalidCompanyActionMessage(actions[invalidIndex], invalidIndex));
  }
  return parsed;
}

function invalidCompanyActionMessage(value: unknown, index: number): string {
  const prefix = `Company action ${index + 1} is invalid`;
  if (!isRecord(value)) return `${prefix}: expected an object with a supported type`;
  if (value.type === "hire_and_delegate") {
    if (
      typeof value.role === "string" &&
      typeof value.workTitle === "string" &&
      typeof value.workDescription === "string" &&
      requiresCommercialEvidence({
        role: value.role as HireAndDelegateAction["role"],
        workTitle: value.workTitle,
        workDescription: value.workDescription,
      })
    ) {
      const artifacts = Array.isArray(value.artifactPaths) ? value.artifactPaths : [];
      const evidence = [
        ...(Array.isArray(value.citationPaths) ? value.citationPaths : []),
        ...(Array.isArray(value.commercialClaimPaths) ? value.commercialClaimPaths : []),
      ];
      if (evidence.length < 2) {
        return `${prefix}: commercial work requires non-empty artifactPaths, citationPaths, and commercialClaimPaths`;
      }
      const missing = evidence.filter((path) => !artifacts.includes(path));
      if (missing.length > 0) {
        return `${prefix}: artifactPaths must include every evidence path (${missing.join(", ")})`;
      }
    }
    return `${prefix}: hire_and_delegate requires a valid non-CEO agentId, title, role, description, workTitle, and workDescription`;
  }
  if (value.type === "create_milestone") {
    return `${prefix}: create_milestone requires projectId, title, outcome, non-negative integer sequence, and acceptance object`;
  }
  if (value.type === "define_and_start_process") {
    if (isRecord(value.policy) && value.policy.schedule !== undefined) {
      return `${prefix}: policy.schedule must be a valid interval or cron schedule`;
    }
    return `${prefix}: define_and_start_process requires projectId, milestoneSequence, and a valid process definition`;
  }
  return `${prefix}: supported types are hire_and_delegate, create_milestone, and define_and_start_process`;
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

export function recurringProcessSchedule(policy: unknown): Trigger | null {
  if (!isRecord(policy) || policy.schedule === undefined) return null;
  const parsed = triggerSchema.safeParse(policy.schedule);
  if (
    !parsed.success ||
    !["interval", "cron"].includes(parsed.data.kind) ||
    nextScheduledOccurrence({ schedule: parsed.data }, new Date()) === null
  ) {
    return null;
  }
  return parsed.data;
}

function parseCompanyActions(values: unknown[]): CompanyAction[] {
  const actions: CompanyAction[] = [];
  for (const action of values) {
    if (isHireAndDelegateAction(action)) {
      actions.push({
        type: action.type,
        agentId: action.agentId,
        title: action.title,
        role: action.role,
        description: action.description,
        workTitle: action.workTitle,
        workDescription: action.workDescription,
        ...(action.projectId === undefined ? {} : { projectId: action.projectId }),
        ...(action.projectRole === undefined ? {} : { projectRole: action.projectRole }),
        ...(action.skillKeys === undefined ? {} : { skillKeys: action.skillKeys }),
        ...(action.artifactPaths === undefined ? {} : { artifactPaths: action.artifactPaths }),
        ...(action.citationPaths === undefined ? {} : { citationPaths: action.citationPaths }),
        ...(action.commercialClaimPaths === undefined
          ? {}
          : { commercialClaimPaths: action.commercialClaimPaths }),
      });
    } else if (isCreateMilestoneAction(action)) {
      actions.push({
        type: action.type,
        projectId: action.projectId,
        title: action.title,
        outcome: action.outcome,
        sequence: action.sequence,
        acceptance: action.acceptance,
      });
    } else if (isDefineAndStartProcessAction(action)) {
      actions.push({
        type: action.type,
        projectId: action.projectId,
        milestoneSequence: action.milestoneSequence,
        definition: action.definition,
        ...(action.loopId === undefined ? {} : { loopId: action.loopId }),
        ...(action.policy === undefined ? {} : { policy: action.policy }),
      });
    }
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
    (action.projectId === undefined ||
      (typeof action.projectId === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(action.projectId))) &&
    (action.projectRole === undefined ||
      action.projectRole === "manager" ||
      action.projectRole === "member") &&
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

function isCreateMilestoneAction(value: unknown): value is CreateMilestoneAction {
  if (!isRecord(value)) return false;
  return (
    value.type === "create_milestone" &&
    isIdentifier(value.projectId) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.length <= 512 &&
    typeof value.outcome === "string" &&
    value.outcome.length <= 16_384 &&
    Number.isInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    isRecord(value.acceptance)
  );
}

function isDefineAndStartProcessAction(value: unknown): value is DefineAndStartProcessAction {
  if (!isRecord(value)) return false;
  const validPolicy =
    value.policy === undefined ||
    (isRecord(value.policy) &&
      !("_aaspaiContinuation" in value.policy) &&
      (value.policy.schedule === undefined || recurringProcessSchedule(value.policy) !== null));
  return (
    value.type === "define_and_start_process" &&
    isIdentifier(value.projectId) &&
    Number.isInteger(value.milestoneSequence) &&
    Number(value.milestoneSequence) >= 0 &&
    processDefinitionSchema.safeParse(value.definition).success &&
    (value.loopId === undefined || isIdentifier(value.loopId)) &&
    validPolicy
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value);
}

function isCompanyActionType(value: unknown): value is CompanyAction["type"] {
  return (
    value === "hire_and_delegate" ||
    value === "create_milestone" ||
    value === "define_and_start_process"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
