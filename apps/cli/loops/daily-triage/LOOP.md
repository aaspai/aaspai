---
id: loop/daily-triage
type: LoopPattern
title: "Daily Triage"
description: >
  Morning scan of CI failures, open issues, and recent commits.
timestamp: 2026-07-21T00:00:00Z
schedule:
  kind: cron
  expression: "0 8 * * 1-5"
  timezone: "UTC"
agent: agent/operator
autonomyLevel: L1
status: enabled
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
configJson: "{}"
gateJson: "{}"
budgetJson: "{}"
---

# Daily Triage

This loop runs every weekday morning. The operator agent reviews
discovered issues, decides what's worth attention, and writes to
STATE.md.
