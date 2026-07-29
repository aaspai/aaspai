import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PullRequest,
  PullRequestInput,
  PullRequestLookup,
  PullRequestProvider,
} from "../contract/index.js";

const execFileAsync = promisify(execFile);

export interface PullRequestCommandRunner {
  run(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }>;
}

export class LocalPullRequestCommandRunner implements PullRequestCommandRunner {
  async run(
    args: readonly string[],
    options: { cwd?: string } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync("gh", [...args], {
        cwd: options.cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const detail = error as { stderr?: string; stdout?: string };
      throw new Error(
        `GitHub CLI command failed: ${detail.stderr ?? detail.stdout ?? String(error)}`,
      );
    }
  }
}

export class LocalGitHubPullRequestProvider implements PullRequestProvider {
  constructor(
    private readonly runner: PullRequestCommandRunner = new LocalPullRequestCommandRunner(),
  ) {}

  async create(input: PullRequestInput): Promise<PullRequest> {
    const result = await this.runner.run([
      "pr",
      "create",
      "--repo",
      normalizeRepository(input.repository),
      "--head",
      input.head,
      "--base",
      input.base,
      "--title",
      input.title,
      "--body",
      input.body,
      ...(input.draft ? ["--draft"] : []),
    ]);
    const url = parseCreatedPullRequestUrl(result.stdout);
    return {
      number: url.number,
      url: url.url,
      state: "open",
      head: input.head,
      base: input.base,
    };
  }

  async get(repository: string, number: number): Promise<PullRequest> {
    const result = await this.runner.run([
      "pr",
      "view",
      String(number),
      "--repo",
      normalizeRepository(repository),
      "--json",
      "number,url,state,headRefName,baseRefName",
    ]);
    return parsePullRequest(JSON.parse(result.stdout) as Record<string, unknown>);
  }

  async find(input: PullRequestLookup): Promise<PullRequest | null> {
    const result = await this.runner.run([
      "pr",
      "list",
      "--repo",
      normalizeRepository(input.repository),
      "--head",
      input.head,
      "--base",
      input.base,
      "--state",
      "all",
      "--limit",
      "2",
      "--json",
      "number,url,state,headRefName,baseRefName",
    ]);
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) {
      throw new Error("GitHub CLI returned an invalid pull request list");
    }
    const matches = parsed.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("GitHub CLI returned an invalid pull request");
      }
      return parsePullRequest(item as Record<string, unknown>);
    });
    if (
      matches.some(
        (pullRequest) => pullRequest.head !== input.head || pullRequest.base !== input.base,
      )
    ) {
      throw new Error("GitHub CLI returned a pull request for different branches");
    }
    if (matches.length > 1) {
      throw new Error("GitHub CLI returned multiple pull requests for the same branches");
    }
    return matches[0] ?? null;
  }
}

function parseCreatedPullRequestUrl(stdout: string): { number: number; url: string } {
  const url = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\/[^\s]+\/pull\/\d+(?:\?[^\s]*)?$/.test(line));
  const match = url?.match(/^(https?:\/\/[^\s]+\/pull\/(\d+))(?:\?[^\s]*)?$/);
  const pullRequestUrl = match?.[1];
  const number = match?.[2];
  if (!pullRequestUrl || !number) {
    throw new Error("GitHub CLI did not return a pull request URL");
  }
  return { number: Number(number), url: pullRequestUrl };
}

function normalizeRepository(repository: string): string {
  const value = repository.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return value;
  const match = value.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match?.[1] || !match[2])
    throw new Error(`Unsupported GitHub repository remote: ${repository}`);
  return `${match[1]}/${match[2]}`;
}

function parsePullRequest(input: Record<string, unknown>): PullRequest {
  const state = input.state;
  const url = typeof input.url === "string" ? input.url : null;
  const urlMatch = url?.match(/^https?:\/\/[^\s]+\/pull\/(\d+)$/);
  const mappedState =
    state === "MERGED"
      ? "merged"
      : state === "CLOSED"
        ? "closed"
        : state === "OPEN"
          ? "open"
          : null;
  if (
    typeof input.number !== "number" ||
    !Number.isSafeInteger(input.number) ||
    input.number < 1 ||
    !url ||
    !urlMatch ||
    Number(urlMatch[1]) !== input.number ||
    typeof input.headRefName !== "string" ||
    input.headRefName.length === 0 ||
    typeof input.baseRefName !== "string" ||
    input.baseRefName.length === 0 ||
    mappedState === null
  ) {
    throw new Error("GitHub CLI returned an invalid pull request");
  }
  return {
    number: input.number,
    url,
    state: mappedState,
    head: input.headRefName,
    base: input.baseRefName,
  };
}
