import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const URL = /https?:\/\/\S+/i;
const COMMERCIAL_CLAIM =
  /\b(?:SOC\s*2|ISO\s*27001|SLA|uptime|zero[- ]retention|integrates?\s+with|integration\s+with|case study|certif(?:ied|ication)|compliant|guarantee(?:d)?|(?:customers?|clients?)\s+(?:include|such as|use|trust))\b/i;

export async function validateEvidencePolicy(
  workspacePath: string,
  metadata: unknown,
  artifactPaths: readonly string[] = [],
): Promise<void> {
  const policy =
    metadata && typeof metadata === "object"
      ? (metadata as { evidencePolicy?: unknown }).evidencePolicy
      : undefined;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return;
  const citationPaths = pathList((policy as { citationPaths?: unknown }).citationPaths);
  const declaredCommercialClaimPaths = pathList(
    (policy as { commercialClaimPaths?: unknown }).commercialClaimPaths,
  );
  const scanAllArtifacts = (policy as { scanAllArtifacts?: unknown }).scanAllArtifacts === true;
  const textArtifacts = scanAllArtifacts
    ? artifactPaths.filter((path) =>
        [".csv", ".html", ".json", ".md", ".txt"].includes(extname(path).toLowerCase()),
      )
    : [];
  const commercialClaimPaths = [...new Set([...declaredCommercialClaimPaths, ...textArtifacts])];
  const root = await realpath(workspacePath);

  for (const path of new Set([...citationPaths, ...commercialClaimPaths])) {
    if (!artifactPaths.includes(path)) {
      throw new Error(`Evidence path is not a declared durable artifact: ${path}`);
    }
    const source = await realpath(resolve(root, path));
    const scoped = relative(root, source);
    if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) {
      throw new Error(`Evidence path escapes the workspace: ${path}`);
    }
    const text = await readFile(source, "utf8");
    const lines = text.split(/\r?\n/);
    if (citationPaths.includes(path) || looksLikeLeadArtifact(path, lines)) {
      const tableRows = lines.filter(
        (line) =>
          /^\s*\|/.test(line) &&
          !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) &&
          !/\b(?:source|url|website|citation)\b/i.test(line),
      );
      const claims =
        tableRows.length > 0 ? tableRows : lines.filter((line) => /^\s*[-*]\s+/.test(line));
      if (claims.length === 0 || claims.some((line) => !URL.test(line))) {
        throw new Error(`Every lead must include an HTTP citation in ${path}`);
      }
    }
    if (
      commercialClaimPaths.includes(path) &&
      lines.some((line) => COMMERCIAL_CLAIM.test(line) && !URL.test(line))
    ) {
      throw new Error(`Unsupported commercial or security claim in ${path}`);
    }
  }
}

function looksLikeLeadArtifact(path: string, lines: readonly string[]): boolean {
  return (
    /\b(?:lead|prospect)s?\b/i.test(path) ||
    lines.some(
      (line) =>
        /^\s*\|/.test(line) &&
        /\b(?:lead|company|prospect)\b/i.test(line) &&
        /\b(?:source|url|website|citation)\b/i.test(line),
    )
  );
}

function pathList(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((path) => typeof path !== "string" || !path || path.length > 8_192)
  ) {
    throw new Error("Evidence policy paths must be an array of at most 32 relative paths");
  }
  return value as string[];
}
