/** Human-friendly label for an agent role (single source of truth). */
export const ROLE_LABEL: Record<string, string> = {
  ceo: "Chief of Staff",
  cto: "CTO",
  cmo: "Marketing",
  cfo: "Finance",
  security: "Security",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  operator: "Manager",
  general: "Generalist",
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}
