#!/usr/bin/env bash
# POSIX shim for the fake opencode CLI used by harness / sessions e2e tests.
# Mirrors the Windows .cmd shim so the test can rely on a single
# "executable path" per platform.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/fake-opencode.cjs" "$@"
