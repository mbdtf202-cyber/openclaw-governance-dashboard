import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginService, PluginLogger } from "openclaw/plugin-sdk/core";
import {
  computeGovernanceRepoFingerprint,
  resolveOpenClawRepoRoot,
  scanGovernanceSnapshot,
} from "./scanner.js";
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

type GovernanceCachePayload = {
  fingerprint: string | null;
  lastSuccessfulScanAt: string | null;
  snapshot: GovernanceSnapshot;
};

function buildResult(params: {
  available: boolean;
  pluginId: string;
  pluginVersion?: string;
  repoRoot?: string | null;
  config: GovernancePluginConfig;
  snapshot?: GovernanceSnapshot | null;
  lastSuccessfulScanAt?: string | null;
  stale?: boolean;
  message?: string;
}): GovernanceSnapshotResult {
  return {
    available: params.available,
    pluginId: params.pluginId,
    pluginVersion: params.pluginVersion,
    repoRoot: params.repoRoot ?? params.snapshot?.repoRoot ?? null,
    refreshedAt: params.snapshot?.generatedAt ?? new Date().toISOString(),
    lastSuccessfulScanAt: params.lastSuccessfulScanAt ?? params.snapshot?.generatedAt ?? null,
    stale: params.stale === true,
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
  let latestFingerprint: string | null = null;
  let lastSuccessfulScanAt: string | null = null;
  let workspaceDir: string | undefined;
  let cachePath: string | null = null;
  let refreshPromise: Promise<GovernanceSnapshotResult> | null = null;
  let refreshInterval: NodeJS.Timeout | null = null;

  const persistSnapshot = async () => {
    if (!cachePath || !latestSnapshot) {
      return;
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const payload: GovernanceCachePayload = {
      fingerprint: latestFingerprint,
      lastSuccessfulScanAt,
      snapshot: latestSnapshot,
    };
    await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), "utf8");
  };

  const hydrateCache = async () => {
    if (!cachePath) {
      return;
    }
    try {
      const raw = await fs.readFile(cachePath, "utf8");
      const parsed = JSON.parse(raw) as GovernanceCachePayload | GovernanceSnapshot;
      if (
        parsed &&
        typeof parsed === "object" &&
        "snapshot" in parsed &&
        parsed.snapshot &&
        typeof parsed.snapshot === "object"
      ) {
        latestSnapshot = parsed.snapshot as GovernanceSnapshot;
        latestFingerprint =
          typeof parsed.fingerprint === "string" && parsed.fingerprint.trim()
            ? parsed.fingerprint
            : null;
        lastSuccessfulScanAt =
          typeof parsed.lastSuccessfulScanAt === "string" && parsed.lastSuccessfulScanAt.trim()
            ? parsed.lastSuccessfulScanAt
            : latestSnapshot.generatedAt;
        return;
      }
      latestSnapshot = parsed as GovernanceSnapshot;
      latestFingerprint = null;
      lastSuccessfulScanAt = latestSnapshot.generatedAt;
    } catch {
      latestSnapshot = latestSnapshot ?? null;
      latestFingerprint = latestFingerprint ?? null;
      lastSuccessfulScanAt = lastSuccessfulScanAt ?? latestSnapshot?.generatedAt ?? null;
    }
  };

  const refresh = async (force = false): Promise<GovernanceSnapshotResult> => {
    if (!params.config.enabled) {
      return buildResult({
        available: false,
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        config: params.config,
        lastSuccessfulScanAt,
        message: "Governance dashboard is disabled in plugin config.",
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
          lastSuccessfulScanAt,
          stale: latestSnapshot !== null,
          message:
            "OpenClaw repo root could not be resolved automatically. Set plugins.entries.governance-dashboard.config.repoRoot to scan a checkout explicitly.",
        });
      }

      const fingerprint = await computeGovernanceRepoFingerprint({
        repoRoot,
        config: params.config,
      }).catch(() => null);
      if (
        !force &&
        latestSnapshot &&
        latestFingerprint &&
        fingerprint?.value &&
        fingerprint.value === latestFingerprint
      ) {
        return buildResult({
          available: true,
          pluginId: params.pluginId,
          pluginVersion: params.pluginVersion,
          config: params.config,
          repoRoot,
          snapshot: latestSnapshot,
          lastSuccessfulScanAt,
        });
      }

      try {
        latestSnapshot = await scanGovernanceSnapshot({
          repoRoot,
          config: params.config,
          log: params.logger,
        });
        latestFingerprint = fingerprint?.value ?? latestFingerprint;
        lastSuccessfulScanAt = latestSnapshot.generatedAt;
        await persistSnapshot().catch((err) => {
          params.logger.warn?.(`[governance-dashboard] failed to persist snapshot: ${String(err)}`);
        });
        return buildResult({
          available: true,
          pluginId: params.pluginId,
          pluginVersion: params.pluginVersion,
          config: params.config,
          snapshot: latestSnapshot,
          lastSuccessfulScanAt,
        });
      } catch (error) {
        if (!latestSnapshot) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        return buildResult({
          available: true,
          pluginId: params.pluginId,
          pluginVersion: params.pluginVersion,
          config: params.config,
          repoRoot,
          snapshot: latestSnapshot,
          lastSuccessfulScanAt,
          stale: true,
          message: `Showing cached snapshot because the latest governance scan failed: ${errorMessage}`,
        });
      }
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
          void refresh(false).catch((err) => {
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
