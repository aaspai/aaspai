# `@aaspai/skills`

Skill catalog + registry for the aaspai harness. Defines the `Skill`
data model, the in-memory `SkillRegistry`, the file-system
`SkillCatalog` (mirrors `@paperclipai/skills-catalog`'s shape), and
the `materialize()` primitive that writes `SKILL.md` files to a
target adapter's runtime dir.

## Public surface

```ts
import {
  SkillRegistry,            // in-memory skill index
  SkillCatalog,             // on-disk catalog builder (catalog/{bundled,optional}/<category>/<slug>/)
  loadSkillDirectory,       // legacy: load a flat dir of SKILL.md files
  loadSkillFile,            // read a single SKILL.md → ParsedFile<Skill>
  parseSkillFile,           // parse SKILL.md from a string
  writeSkillFile,           // write Skill → SKILL.md
  sha256HexSync,            // SHA-256 of a string
  classifySkillFilePath,    // "skill" | "markdown" | "reference" | "script" | "asset" | "other"
} from "@aaspai/skills";
```

## Skill data model

```ts
{
  key: string,                              // "deploy-vercel"
  version: string,                          // "1.0.0"
  name: string,
  description: string,
  instructions: string,                     // SKILL.md body
  files: Array<{
    path: string,
    content: string,
    kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other",
    sha256?: string,                        // 64-char hex
  }>,
  adapterTypes: string[],
  owner: string,
  visibility: "private" | "organization" | "public",
  createdAt: string,                        // ISO
  updatedAt: string,
  archivedAt: string | null,
}
```

## Catalog layout (on disk)

```
catalog/
├── bundled/
│   ├── <category>/
│   │   ├── <slug>/
│   │   │   ├── SKILL.md             ← required, OKF frontmatter + body
│   │   │   ├── references/          ← optional, kind="reference"
│   │   │   ├── scripts/             ← optional, kind="script"
│   │   │   └── assets/              ← optional, kind="asset"
├── optional/
│   ├── <category>/
│   │   ├── <slug>/
│   │   │   ├── SKILL.md             ← OR
│   │   │   ├── catalog-ref.json     ← alternative: GitHub-pinned source
```

`SKILL.md` and `catalog-ref.json` are **mutually exclusive** in a single
skill directory.

### `catalog-ref.json` (GitHub-pinned skills)

```json
{
  "source": {
    "type": "github",
    "owner": "mvanhorn",
    "repo": "last30days-skill",
    "ref": "v3.3.0",
    "commit": "daca71f89eb71d0d56d01a43ed7627aa919dba4f",
    "path": "skills/last30days"
  },
  "files": ["SKILL.md", "scripts/briefing.py"],
  "tags": ["research", "news"]
}
```

## Usage

```ts
import { SkillCatalog, SkillRegistry } from "@aaspai/skills";

// 1. Build a registry from a catalog tree
const { catalog, manifest, errors } = await SkillCatalog.load("/path/to/skills");
const reg = new SkillRegistry();
await catalog.registerAllInto(reg, { fetchGithub: true });

// 2. Materialize the resolved skills to an adapter's runtime dir
const resolved = reg.list().filter((s) => s.adapterTypes.includes("opencode_cli"));
await reg.materialize(resolved, {
  adapterType: "opencode_cli",
  runtimeBaseDir: process.cwd(),
  sharedHome: true,        // write to ~/.claude/skills (the opencode CLI default)
  symlink: true,           // symlink target → cache under .aaspai/skills/<key>/
  verifySha256: true,      // check every file's sha256 before writing
});
```

## Tests

14 unit tests in `__tests__/catalog.test.ts` + `__tests__/parsers.test.ts`:

- walks the catalog tree, sorts by id, validates every skill
- classifies file kinds from path
- derives trustLevel from file kinds
- resolves by id, key, and unique slug
- rejects a directory with both SKILL.md and catalog-ref.json
- rejects a directory missing both
- `registerAllInto` populates a `SkillRegistry` from local skills
- `materialize()` writes SKILL.md + every file under `<base>/.<adapter>/skills/<key>/`
- `sharedHome=true` writes to `~/.claude/skills`
- `materialize()` reports sha256 mismatches as errors
- `verifySha256=false` writes the file even with a bad sha
- `selectFor()` ranks by name/description/tag substring
- `loadSkillDirectory` (legacy flat-dir loader) round-trip

## How to run

```sh
cd packages/skills
node ../../node_modules/vitest/vitest.mjs run
```
