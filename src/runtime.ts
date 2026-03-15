import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginService, PluginLogger } from "openclaw/plugin-sdk/core";
import { resolveOpenClawRepoRoot, scanGovernanceSnapshot } from "./scanner.js";
import type {
  GovernancePluginConfig,
  GovernanceSnapshot,
  GovernanceSnapshotResult,
} from "./types.js";

type RuntimeParams = {
  config: GovernancePluginConfig;
  logger: PluginLogger;
  pluginId: string;
  pluginVersion?: string;
  pluginSourcePath: string;
};

type ServiceStartContext = {
  workspaceDir?: string;
  stateDir: string;
};

function buildResult(params: {
  available: boolean;
  pluginId: string;
  pluginVersion?: string;
  repoRoot?: string | null;
  config: GovernancePluginConfig;
  snapshot?: GovernanceSnapshot | null;
  message?: string;
}): GovernanceSnapshotResult {
  return {
    available: params.available,
    pluginId: params.pluginId,
    pluginVersion: params.pluginVersion,
    repoRoot: params.repoRoot ?? params.snapshot?.repoRoot ?? null,
    refreshedAt: params.snapshot?.generatedAt ?? new Date().toISOString(),
    config: {
      refreshIntervalMs: params.config.refreshIntervalMs,
      largeFileLineThreshold: params.config.largeFileLineThreshold,
      hotspotLimit: params.config.hotspotLimit,
    },
    message: params.message,
    snapshot: params.snapshot ?? null,
  };
}

export function createGovernanceRuntime(params: RuntimeParams): {
  service: OpenClawPluginService;
  getSnapshot: (opts?: { force?: boolean }) => Promise<GovernanceSnapshotResult>;
} {
  let latestSnapshot: GovernanceSnapshot | null = null;
  let workspaceDir: string | undefined;
  let cachePath: string | null = null;
  let refreshPromise: Promise<GovernanceSnapshotResult> | null = null;
  let refreshInterval: NodeJS.Timeout | null = null;

  const persistSnapshot = async () => {
    if (!cachePath || !latestSnapshot) {
      return;
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(latestSnapshot, null, 2), "utf8");
  };

  const hydrateCache = async () => {
    if (!cachePath) {
      return;
    }
    try {
      const raw = await fs.readFile(cachePath, "utf8");
      latestSnapshot = JSON.parse(raw) as GovernanceSnapshot;
    } catch {
      latestSnapshot = latestSnapshot ?? null;
    }
  };

  const refresh = async (force = false): Promise<GovernanceSnapshotResult> => {
    if (!params.config.enabled) {
      return buildResult({
        available: false,
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        config: params.config,
        message: "Governance dashboard is disabled in plugin config.",
      });
    }
    if (!force && latestSnapshot) {
      return buildResult({
        available: true,
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        config: params.config,
        snapshot: latestSnapshot,
      });
    }
    if (refreshPromise) {
      return await refreshPromise;
    }

    refreshPromise = (async () => {
      const repoRoot = await resolveOpenClawRepoRoot({
        configuredRepoRoot: params.config.repoRoot,
        workspaceDir,
        pluginSourcePath: params.pluginSourcePath,
      });
      if (!repoRoot) {
        return buildResult({
          available: true,
          pluginId: params.pluginId,
          pluginVersion: params.pluginVersion,
          config: params.config,
          repoRoot: null,
          snapshot: latestSnapshot,
          message:
            "OpenClaw repo root could not be resolved automatically. Set plugins.entries.governance-dashboard.config.repoRoot to scan a checkout explicitly.",
        });
      }

      latestSnapshot = await scanGovernanceSnapshot({
        repoRoot,
        config: params.config,
        log: params.logger,
      });
      await persistSnapshot().catch((err) => {
        params.logger.warn?.(`[governance-dashboard] failed to persist snapshot: ${String(err)}`);
      });
      return buildResult({
        available: true,
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        config: params.config,
        snapshot: latestSnapshot,
      });
    })().finally(() => {
      refreshPromise = null;
    });

    return await refreshPromise;
  };

  const service: OpenClawPluginService = {
    id: "governance-dashboard",
    start: async (ctx) => {
      workspaceDir = ctx.workspaceDir;
      cachePath = path.join(ctx.stateDir, "governance-dashboard", "latest.json");
      await hydrateCache();
      void refresh(false).catch((err) => {
        params.logger.warn?.(`[governance-dashboard] initial scan failed: ${String(err)}`);
      });

      if (params.config.refreshIntervalMs > 0) {
        refreshInterval = setInterval(() => {
          void refresh(true).catch((err) => {
            params.logger.warn?.(`[governance-dashboard] scheduled scan failed: ${String(err)}`);
          });
        }, params.config.refreshIntervalMs);
        refreshInterval.unref?.();
      }
    },
    stop: async () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
    },
  };

  return {
    service,
    getSnapshot: async (opts) => await refresh(opts?.force === true),
  };
}
