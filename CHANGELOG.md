# Changelog

## 0.1.2

- Distinguish missing versus invalid governance artifacts instead of silently swallowing parse failures.
- Fix domain large-file summaries to use the full scan result rather than the truncated hotspot list.
- Ignore generated output during filesystem fallback scans and add repo fingerprint caching to avoid unnecessary rescans.
- Add stale-snapshot metadata and scan-cost telemetry to the governance RPC surface.
- Expand plugin tests to cover invalid JSON, fallback scanning, rescans, and stale cache behavior.

## 0.1.1

- Validate OpenClaw core patch applicability in CI and release flow.
- Add host-side plugin entry smoke coverage.
- Fix domain hotspot counts so summaries use all large files, not only displayed hotspots.
- Harden governance scaffold script with OpenClaw repo validation and skip-existing behavior.
- Ship `.github/CODEOWNERS` and `.github/labeler.yml` templates.
- Switch CI and release installs to `npm ci`.

## 0.1.0

- Initial public release.
- Ships the standalone `governance-dashboard` OpenClaw plugin.
- Includes governance scaffolding templates and an OpenClaw core integration patch.
