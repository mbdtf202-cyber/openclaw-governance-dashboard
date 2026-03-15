# OpenClaw Governance Dashboard

Standalone public product repository for the OpenClaw Governance Dashboard.

This repository ships three things:

1. the `governance-dashboard` OpenClaw plugin
2. governance scaffolding templates for target repos
3. an OpenClaw core integration patch that adds the dashboard tab and host-side wiring

## What it does

The plugin scans an OpenClaw checkout and surfaces:

- architecture guardrails
- domain map coverage
- capability registry coverage
- ADR presence
- large-file hotspots
- missing ownership signals

## Product shape

This repo is meant to be consumed as a standalone product, not just copied out of
the main OpenClaw monorepo.

It includes:

- `index.ts`
- `openclaw.plugin.json`
- `src/*`
- `templates/`
- `integrations/openclaw-core/openclaw-governance-dashboard.patch`
- GitHub release workflow and packaging script

## Install the plugin

After downloading a release asset:

```bash
openclaw plugins install ./<downloaded-release-asset>.tgz
```

Restart the OpenClaw gateway afterwards.

## Apply the OpenClaw core integration

If your OpenClaw build does not already contain the Governance tab and host-side
wiring, apply the included patch in an OpenClaw checkout:

```bash
git apply /path/to/openclaw-governance-dashboard.patch
```

The patch adds:

- dashboard navigation and view wiring
- governance RPC controller in Control UI
- bundled default-on enablement for the plugin
- targeted tests for the new host-side behavior

## Scaffold governance files into a target repo

This repository also ships governance templates. To copy them into an OpenClaw
checkout:

```bash
node scripts/scaffold-governance-skeleton.mjs /path/to/openclaw
```

That seeds:

- `governance/domain-map.json`
- `governance/capabilities/*.json`
- `docs/adr/0001-repo-governance-foundation.md`
- `.github/CODEOWNERS`
- `.github/labeler.yml`

Existing files are skipped by default. Pass `--force` to overwrite them.
When possible, the scaffold derives the CODEOWNERS owner from the target repo's
`origin` remote.

## Requirements

- Node 22+
- OpenClaw `>= 2026.3.15`

## Local validation

```bash
npm ci
npm test
bash scripts/check-openclaw-patch.sh
bash scripts/release-plugin.sh
```

## Public release assets

Every GitHub release publishes:

- plugin `.tgz`
- `.sha256`
- release README
- OpenClaw core integration patch
