import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateEvidencePolicy } from "../src/output-policy.js";

const root = resolve("workspace", "worker-output-policy");

describe("output evidence policy", () => {
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("requires lead citations and rejects unsupported commercial claims", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/leads.md`, "| Lead | Source |\n|---|---|\n| Acme | no source |\n");
    await writeFile(`${root}/campaign.md`, "Guaranteed 99.9% uptime.\n");
    const metadata = {
      evidencePolicy: {
        citationPaths: ["leads.md"],
        commercialClaimPaths: ["campaign.md"],
      },
    };
    await expect(
      validateEvidencePolicy(root, metadata, ["leads.md", "campaign.md"]),
    ).rejects.toThrow("Every lead");
    await writeFile(
      `${root}/leads.md`,
      "| Lead | Source |\n|---|---|\n| Acme | https://acme.test |\n",
    );
    await expect(
      validateEvidencePolicy(root, metadata, ["leads.md", "campaign.md"]),
    ).rejects.toThrow("Unsupported");
    await writeFile(
      `${root}/campaign.md`,
      "Published SLA: 99.9% uptime https://example.test/sla\n",
    );
    await expect(
      validateEvidencePolicy(root, metadata, ["leads.md", "campaign.md"]),
    ).resolves.toBeUndefined();
  });

  it("scans every declared text artifact instead of trusting model-selected claim paths", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/clean.md`, "- Evidence https://example.test/source\n");
    await writeFile(`${root}/campaign.md`, "Guaranteed 99.9% uptime.\n");
    await expect(
      validateEvidencePolicy(
        root,
        {
          evidencePolicy: {
            citationPaths: ["clean.md"],
            commercialClaimPaths: ["clean.md"],
            scanAllArtifacts: true,
          },
        },
        ["clean.md", "campaign.md"],
      ),
    ).rejects.toThrow("Unsupported");
  });

  it("requires evidence files to be exported as durable artifacts", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/leads.md`, "- Zedblock https://zedblock.com\n", "utf8");

    await expect(
      validateEvidencePolicy(root, {
        evidencePolicy: {
          citationPaths: ["leads.md"],
        },
      }),
    ).rejects.toThrow("not a declared durable artifact");
  });
});
