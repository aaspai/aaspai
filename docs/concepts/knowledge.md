# Knowledge

Knowledge is reviewed, versioned organizational truth stored as Markdown with
typed YAML frontmatter under `.aaspai/knowledge/`.

```text
.aaspai/knowledge/
|-- company/
|-- product/
`-- engineering/
```

Agents select knowledge by configured scope. The loader validates files and
provides matching content to session/execution preparation.

## Knowledge is not raw memory

The architecture separates:

- raw transcripts and artifacts: execution evidence;
- scoped operational memory: database state used by active work;
- accepted knowledge: reviewed files in Git.

An agent result does not become organizational truth merely because a run
succeeded. Proposed knowledge should be reviewed before it changes the
Git-backed source.

## Commands

```sh
yarn workspace @aaspai/cli start knowledge list
yarn workspace @aaspai/cli start knowledge search "release process"
yarn workspace @aaspai/cli start knowledge show company/mission
yarn workspace @aaspai/cli start knowledge new engineering/release-process
yarn workspace @aaspai/cli start knowledge validate
```

See [Agents](./agents.md) and [Architecture](../architecture.md).
