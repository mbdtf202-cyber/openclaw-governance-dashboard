# 0001 Repo Governance Foundation

## Status

Accepted

## Context

OpenClaw is growing along multiple axes at the same time:

- gateway/runtime platform
- agent execution and durable tasks
- built-in and extension channels
- control surfaces such as CLI and Control UI
- experiments, packaged workspaces, and proposal kits

The repo already contains local guardrails such as boundary checks and max-line
budgets, but those rules are scattered and not exposed through a coherent
operator-facing system.

## Decision

We establish a repository-native governance skeleton with three artifacts:

1. `governance/domain-map.json`
2. `governance/capabilities/*.json`
3. `docs/adr/*`

We also treat the Governance Dashboard plugin as the operator-facing read model
for these artifacts plus repo-derived health signals such as large-file drift
and missing ownership routing.

## Consequences

- Governance state becomes versioned in Git, not spread across chat or issue history.
- New product or platform work has an explicit place to declare ownership and maturity.
- Control UI can expose structural risk without inventing a second source of truth.
- Missing artifacts remain visible as governance debt instead of being silently ignored.
