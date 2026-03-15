import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GovernanceSnapshot } from "./types.js";

const mocks = vi.hoisted(() => ({
  computeGovernanceRepoFingerprint: vi.fn(),
  resolveOpenClawRepoRoot: vi.fn(),
  scanGovernanceSnapshot: vi.fn(),
}));

vi.mock("./scanner.js", () => ({
  computeGovernanceRepoFingerprint: mocks.computeGovernanceRepoFingerprint,
  resolveOpenClawRepoRoot: mocks.resolveOpenClawRepoRoot,
  scanGovernanceSnapshot: mocks.scanGovernanceSnapshot,
}));

import { createGovernanceRuntime } from "./runtime.js";

const tempDirs: string[] = [];

function makeSnapshot(overrides: Partial<GovernanceSnapshot> = {}): GovernanceSnapshot {
  return {
    generatedAt: "2026-03-16T00:00:00.000Z",
    repoRoot: "/repo",
    summary: {
      totalFiles: 10,
      tsFiles: 5,
      extensions: 1,
      docsPages: 1,
      adrCount: 1,
      capabilityCount: 1,
      domainCount: 1,
      largeFileCount: 0,
      maxFileLines: 120,
      analyzedFileCount: 5,
      scanDurationMs: 42,
      score: 92,
    },
    cards: [],
    guardrails: [],
    issues: [],
    hotspots: [],
    domains: [],
    artifacts: [],
    ...overrides,
  };
}

async function makeStateDir() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governance-runtime-"));
  tempDirs.push(stateDir);
  return stateDir;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOpenClawRepoRoot.mockResolvedValue("/repo");
  mocks.computeGovernanceRepoFingerprint.mockResolvedValue({
    value: "git:abc123",
    mode: "git",
    inputCount: 1,
  });
  mocks.scanGovernanceSnapshot.mockResolvedValue(makeSnapshot());
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempDirs.splice(0).map(async (entry) => {
      await fs.rm(entry, { recursive: true, force: true });
    }),
  );
});

describe("createGovernanceRuntime", () => {
  it("skips rescanning when the repo fingerprint is unchanged", async () => {
    const runtime = createGovernanceRuntime({
      config: {
        enabled: true,
        refreshIntervalMs: 60_000,
        largeFileLineThreshold: 500,
        hotspotLimit: 10,
        codePaths: ["src", "ui"],
      },
      logger: {},
      pluginId: "governance-dashboard",
      pluginSourcePath: "/repo/extensions/governance-dashboard/index.ts",
    });

    await runtime.service.start({
      stateDir: await makeStateDir(),
      workspaceDir: "/repo",
    });
    await vi.waitFor(() => {
      expect(mocks.scanGovernanceSnapshot).toHaveBeenCalledTimes(1);
    });

    const result = await runtime.getSnapshot();

    expect(result.stale).toBe(false);
    expect(result.lastSuccessfulScanAt).toBe("2026-03-16T00:00:00.000Z");
    expect(mocks.scanGovernanceSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns a stale cached snapshot when a later rescan fails", async () => {
    const runtime = createGovernanceRuntime({
      config: {
        enabled: true,
        refreshIntervalMs: 60_000,
        largeFileLineThreshold: 500,
        hotspotLimit: 10,
        codePaths: ["src", "ui"],
      },
      logger: {},
      pluginId: "governance-dashboard",
      pluginSourcePath: "/repo/extensions/governance-dashboard/index.ts",
    });

    await runtime.service.start({
      stateDir: await makeStateDir(),
      workspaceDir: "/repo",
    });
    await vi.waitFor(() => {
      expect(mocks.scanGovernanceSnapshot).toHaveBeenCalledTimes(1);
    });

    mocks.computeGovernanceRepoFingerprint.mockResolvedValueOnce({
      value: "git:def456",
      mode: "git",
      inputCount: 2,
    });
    mocks.scanGovernanceSnapshot.mockRejectedValueOnce(new Error("scan blew up"));

    const result = await runtime.getSnapshot();

    expect(result.stale).toBe(true);
    expect(result.snapshot?.generatedAt).toBe("2026-03-16T00:00:00.000Z");
    expect(result.lastSuccessfulScanAt).toBe("2026-03-16T00:00:00.000Z");
    expect(result.message).toContain("scan blew up");
  });

  it("does not start overlapping scheduled refreshes while a scan is in flight", async () => {
    vi.useFakeTimers();
    const deferred = Promise.withResolvers<GovernanceSnapshot>();
    mocks.scanGovernanceSnapshot.mockReturnValueOnce(deferred.promise);

    const runtime = createGovernanceRuntime({
      config: {
        enabled: true,
        refreshIntervalMs: 100,
        largeFileLineThreshold: 500,
        hotspotLimit: 10,
        codePaths: ["src", "ui"],
      },
      logger: {},
      pluginId: "governance-dashboard",
      pluginSourcePath: "/repo/extensions/governance-dashboard/index.ts",
    });

    await runtime.service.start({
      stateDir: await makeStateDir(),
      workspaceDir: "/repo",
    });
    await vi.advanceTimersByTimeAsync(350);

    expect(mocks.scanGovernanceSnapshot).toHaveBeenCalledTimes(1);

    deferred.resolve(makeSnapshot());
    await Promise.resolve();
    await runtime.service.stop?.();
  });
});
