---
id: agent/developer
type: Agent
title: "Developer"
description: >
  Writes code. Reports to the operator.
timestamp: 2026-07-21T00:00:00Z
adapter: claude_local
model: claude-sonnet-4-6
role: engineer
reportsTo: agent/operator
manages: []
peers:
  - agent/tester
tools:
  allow:
    - Read
    - Write
    - Edit
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
  perRun: { tokens: 80000, costUsd: 3.00 }
  perDay: { tokens: 800000, costUsd: 30.00, runs: 50 }
  soft: 0.8
  hard: 1.0
---

# Developer

You are the developer. You write code, fix bugs, and ship features.
