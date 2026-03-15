# Governance

Machine-readable governance files for OpenClaw.

This directory is intentionally simple:

- `domain-map.json` defines bounded contexts and their path ownership seams.
- `capabilities/*.json` defines the units the dashboard should treat as managed product or platform capabilities.

The Governance Dashboard plugin reads these files directly and highlights gaps
when ownership, maturity, or structural artifacts drift.
