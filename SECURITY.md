# Security

If you discover a security vulnerability, **please do not file a public
issue or pull request.**

Report it privately to **contact@aasp.ai**. We aim to acknowledge new
reports within 72 hours.

## What to include

A good report contains:

- A clear description of the issue and its impact.
- A reproducer (commands, request, script) and the affected version/commit.
- Whether the issue is exploitable today and any known mitigations.
- Your assessment of severity, if you have one (CVSS or a short rationale).

## What to expect

- An acknowledgement of your report within 72 hours.
- A triage decision and next steps within 7 days for actionable reports.
- A coordinated disclosure timeline; we will not publicly disclose the issue
  until a fix is available or a reasonable disclosure date is agreed.
- Credit in the release notes and the security advisory, unless you ask to
  remain anonymous.

## Scope

In scope:

- Any code under `apps/` and `packages/`.
- Build, test, and CI configuration that ships with the repository.

Out of scope:

- The development environment itself (your local machine, your CI).
- Vulnerabilities in upstream dependencies that are already publicly known;
  please file a regular issue and link the upstream advisory.

## Supported versions

Only the latest commit on `main` is supported with security fixes. Once we
publish tagged releases, security fixes will be backported to the most
recent minor version.
