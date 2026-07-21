# Contributing to aaspai

Thanks for your interest in contributing. This document covers the
day-to-day mechanics of contributing. Architecture and design lives in
the public docs under [docs/](./docs/).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to its terms.

## License

By contributing, you agree that your contributions will be licensed
under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
See [`LICENSE`](LICENSE) for the full text.

## Development setup

Requirements: Node.js >= 20, Corepack.

```sh
corepack enable
yarn install
```

## Common scripts

Run across all workspaces:

```sh
yarn build
yarn test
yarn lint
yarn typecheck
```

Run in a single workspace:

```sh
yarn workspace @aaspai/<name> <script>
```

## Pull request workflow

1. Fork and create a feature branch from `main`.
2. Make your change. Keep commits focused; squash noise commits before
   review.
3. Make sure `yarn lint`, `yarn typecheck`, and `yarn test` all pass
   locally.
4. Open a PR using the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
5. Address review feedback by pushing new commits; squash on merge.

Commit messages:

- Imperative mood, ≤ 72 chars on the subject line ("Add X", not
  "Added X").
- Reference the issue if one exists: `Fix #123: handle empty skill list`.
- One logical change per commit.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml).
Include: what you expected, what happened, how to reproduce, environment
(Node version, OS, commit hash).

## Reporting security issues

**Do not file a public issue.** See [SECURITY.md](SECURITY.md) for the
private reporting channel.

## Architecture decisions

For non-trivial changes (new package, new external dependency, schema
changes), open an issue first and link it from your PR. Surprises in
review are more expensive than a short discussion up front.
