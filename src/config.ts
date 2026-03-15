import type { GovernancePluginConfig } from "./types.js";

const DEFAULT_CODE_PATHS = ["src", "extensions", "ui", "packages", "scripts", "apps"];

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

export function resolveGovernancePluginConfig(value: unknown): GovernancePluginConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const legacyFocusPaths = readStringArray(raw.focusPaths, []);

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    repoRoot: readTrimmedString(raw.repoRoot),
    refreshIntervalMs: readPositiveInteger(raw.refreshIntervalMs, 5 * 60_000),
    largeFileLineThreshold: readPositiveInteger(raw.largeFileLineThreshold, 500),
    hotspotLimit: readPositiveInteger(raw.hotspotLimit, 12),
    codePaths: readStringArray(
      raw.codePaths,
      legacyFocusPaths.length > 0 ? legacyFocusPaths : DEFAULT_CODE_PATHS,
    ),
  };
}

export const governancePluginConfigSchema = {
  parse: resolveGovernancePluginConfig,
  uiHints: {
    enabled: {
      label: "Enable Governance Dashboard",
      help: "Turn the governance scanner and dashboard RPC on or off.",
    },
    repoRoot: {
      label: "Repository Root",
      help: "Optional absolute path to the OpenClaw repository. Leave empty to auto-detect.",
      advanced: true,
      placeholder: "/path/to/openclaw",
    },
    refreshIntervalMs: {
      label: "Refresh Interval (ms)",
      help: "How often the background service refreshes cached governance data.",
      advanced: true,
    },
    largeFileLineThreshold: {
      label: "Large File Threshold",
      help: "Files above this line count are flagged as governance hotspots.",
      advanced: true,
    },
    hotspotLimit: {
      label: "Hotspot Limit",
      help: "Maximum number of hotspots shown in the dashboard snapshot.",
      advanced: true,
    },
    codePaths: {
      label: "Code Paths",
      help: "Top-level repo code paths scanned for hotspot analysis. Generated output is ignored.",
      advanced: true,
    },
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      repoRoot: { type: "string" },
      refreshIntervalMs: { type: "integer", minimum: 1 },
      largeFileLineThreshold: { type: "integer", minimum: 1 },
      hotspotLimit: { type: "integer", minimum: 1 },
      codePaths: {
        type: "array",
        items: { type: "string" },
      },
      focusPaths: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
};
