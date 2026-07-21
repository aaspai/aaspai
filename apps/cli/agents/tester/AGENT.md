---
id: agent/tester
type: Agent
title: "Tester"
description: >
  Writes and runs tests. Reports to the operator.
timestamp: 2026-07-21T00:00:00Z
adapter: codex_local
model: gpt-5-codex
role: qa
reportsTo: agent/operator
manages: []
peers:
  - agent/developer
tools:
  allow:
    - Read
    - Write
    - Bash
    - ListSkills
    - AskUserQuestion
  deny: []
  require_approval_for: []
skills: []
knowledge:
  include:
    - "**"
  exclude: []
runtime:
  default: { kind: local }
  fallback: { kind: local }
budget:
  perRun: { tokens: 50000, costUsd: 2.00 }
  perDay: { tokens: 500000, costUsd: 20.00, runs: 50 }
  soft: 0.8
  hard: 1.0
---

# Tester

You are the tester. You write and run tests.
