# Knowledge

**Knowledge** in aaspai is the long-term, versioned memory that the
agent reads at the start of a session. It is stored as markdown files
with typed YAML frontmatter (the **OKF** — Open Knowledge Format) and
indexed into the agent's system prompt at session start.

## Why OKF?

Markdown is the lowest-friction format humans will actually write. YAML
frontmatter is the lowest-friction format machines can index. OKF
combines the two.

Every knowledge file is:

- **Editable in any text editor.** No database, no admin UI, no
  migration.
- **Reviewable in a PR.** The diff is the change.
- **Indexed deterministically.** The frontmatter is the index key; the
  body is the content.
- **Glob-addressable.** Agents reference knowledge by path glob
  (`include: ["**"]`), not by ID lookup.

## Anatomy of a knowledge file

A typical project has a `knowledge/` directory:

```
knowledge/
├── _index.md
├── company/
│   ├── mission.md
│   ├── voice.md
│   └── policies/
│       └── code-review.md
├── product/
│   ├── overview.md
│   └── pricing.md
└── engineering/
    ├── style.md
    └── architecture-overview.md
```

Each file looks like:

```markdown
---
type: Concept
title: "Code review policy"
id: knowledge/engineering/policies/code-review
tags: [policy, review]
audience: [developer, operator]
updated: 2026-07-21
---

# Code review policy

All PRs require one reviewer from the engineering team and a green CI
run before merge. Hotfixes can be merged with a single reviewer but
require a follow-up PR for any review feedback.
```

The frontmatter carries the typed metadata; the body is the content.

## How knowledge reaches the agent

When a session starts:

1. The agent's `knowledge.include` and `knowledge.exclude` globs are
   expanded against the `knowledge/` tree.
2. The matched files are loaded and indexed.
3. The index is appended to the system prompt under a stable header
   (e.g. `## Project knowledge`).
4. The session runs.

This happens once per session, not per tool call. The knowledge block
is part of the system prompt and travels with the agent for the entire
session.

## Authoring knowledge

- **One file per concept.** Don't write a single giant
  `everything.md`. Small files compose; big files don't.
- **Frontmatter first.** Decide the `type`, `title`, and `tags` before
  writing prose. They are the index; the body is the content.
- **Reference by glob, not by id.** Let the agent pull what is
  relevant rather than hand-curating lists.
- **Review in PRs.** A change to a knowledge file changes what the
  agent knows. That is a code change.

The CLI scaffolds a new knowledge file with `aaspai knowledge new
<path>`, which writes a valid frontmatter template you can fill in.

## Knowledge vs sessions

A common confusion:

- **Knowledge** is what the agent *knows*. It is configuration. It is
  versioned. It changes in PRs.
- **Sessions** are what the agent *did*. They are state. They live in
  the database. They are append-only.

Do not write run output into a knowledge file. The knowledge file is
the long-term brain, not the run log.

## Where to go next

- [Agents](./agents.md) — how the `knowledge.include` glob is set.
- [Loops](./loops.md) — how the session that reads the knowledge is
  scheduled.
- [Getting started](../getting-started.md) — write your first OKF
  file.
