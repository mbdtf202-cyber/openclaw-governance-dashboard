import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenClawRepoRoot, scanGovernanceSnapshot } from "./scanner.js";

const tempRoots: string[] = [];

function makeLargeFile(lines: number): string {
  return `${Array.from({ length: lines }, (_, index) => `export const line${index} = ${index};`).join("\n")}\n`;
}

async function makeRepoFixture(options?: {
  domainMap?: unknown | string | null;
  capabilities?: Record<string, unknown | string>;
  adrFiles?: Record<string, string>;
  includeCodeowners?: boolean;
  extraFiles?: Array<{ path: string; content: string }>;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governance-"));
  tempRoots.push(root);

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "ui"), { recursive: true });
  await fs.mkdir(path.join(root, "extensions"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, ".github"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "adr"), { recursive: true });
  await fs.mkdir(path.join(root, "governance", "capabilities"), { recursive: true });

  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw" }, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf8");
  await fs.writeFile(
    path.join(root, ".github", "labeler.yml"),
    "docs:\n  - changed-files: []\n",
    "utf8",
  );
  if (options?.includeCodeowners !== false) {
    await fs.writeFile(
      path.join(root, ".github", "CODEOWNERS"),
      "/src/ @platform\n/ui/ @ux\n",
      "utf8",
    );
  }
  await fs.writeFile(path.join(root, "scripts", "check-ts-max-loc.ts"), "export {};\n", "utf8");
  await fs.writeFile(
    path.join(root, "scripts", "check-channel-agnostic-boundaries.mjs"),
    "export {};\n",
    "utf8",
  );

  const domainMap =
    options?.domainMap === undefined
      ? {
          version: 1,
          domains: [
            {
              id: "core",
              label: "Core",
              owners: ["team:platform"],
              paths: ["src"],
            },
            {
              id: "ui",
              label: "UI",
              owners: ["team:ux"],
              paths: ["ui"],
            },
          ],
        }
      : options.domainMap;
  if (typeof domainMap === "string") {
    await fs.writeFile(path.join(root, "governance", "domain-map.json"), domainMap, "utf8");
  } else if (domainMap !== null) {
    await fs.writeFile(
      path.join(root, "governance", "domain-map.json"),
      JSON.stringify(domainMap, null, 2),
      "utf8",
    );
  }

  const capabilities = options?.capabilities ?? {
    "core.json": {
      id: "core",
      label: "Core",
      owners: ["team:platform"],
      paths: ["src"],
    },
    "ui.json": {
      id: "ui",
      label: "UI",
      owners: ["team:ux"],
      paths: ["ui"],
    },
  };
  for (const [name, value] of Object.entries(capabilities)) {
    const targetPath = path.join(root, "governance", "capabilities", name);
    if (typeof value === "string") {
      await fs.writeFile(targetPath, value, "utf8");
      continue;
    }
    await fs.writeFile(targetPath, JSON.stringify(value, null, 2), "utf8");
  }

  const adrFiles = options?.adrFiles ?? {
    "0001-foundation.md": "# ADR\n",
  };
  for (const [name, content] of Object.entries(adrFiles)) {
    await fs.writeFile(path.join(root, "docs", "adr", name), content, "utf8");
  }

  await fs.writeFile(path.join(root, "src", "small.ts"), "export const x = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "ui", "small.ts"), "export const y = 2;\n", "utf8");

  for (const extraFile of options?.extraFiles ?? []) {
    const absolutePath = path.join(root, extraFile.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, extraFile.content, "utf8");
  }

  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (entry) => {
      await fs.rm(entry, { recursive: true, force: true });
    }),
  );
});

describe("resolveOpenClawRepoRoot", () => {
  it("finds the repo root by walking upward", async () => {
    const root = await makeRepoFixture();
    const nested = path.join(root, "src", "nested", "deeper");
    await fs.mkdir(nested, { recursive: true });

    const resolved = await resolveOpenClawRepoRoot({ workspaceDir: nested });
    expect(resolved).toBe(root);
  });
});

describe("scanGovernanceSnapshot", () => {
  it("reports invalid governance artifacts instead of silently treating them as missing", async () => {
    const root = await makeRepoFixture({
      domainMap: "{bad json\n",
      capabilities: {
        "broken.json": "{bad json\n",
      },
      adrFiles: {
        "README.md": "# ADR Index\n",
      },
    });

    const snapshot = await scanGovernanceSnapshot({
      repoRoot: root,
      config: {
        enabled: true,
        refreshIntervalMs: 1000,
        largeFileLineThreshold: 500,
        hotspotLimit: 10,
        codePaths: ["src", "ui"],
      },
    });

    expect(snapshot.guardrails.find((entry) => entry.id === "domain-map")?.status).toBe("invalid");
    expect(snapshot.guardrails.find((entry) => entry.id === "capabilities")?.status).toBe(
      "invalid",
    );
    expect(snapshot.guardrails.find((entry) => entry.id === "adr")?.status).toBe("invalid");
    expect(snapshot.issues.some((entry) => entry.id === "invalid-domain-map")).toBe(true);
    expect(snapshot.issues.some((entry) => entry.id === "invalid-capability-registry")).toBe(true);
    expect(snapshot.issues.some((entry) => entry.id === "invalid-adr-registry")).toBe(true);
    expect(
      snapshot.artifacts.find((entry) => entry.path === "governance/domain-map.json")?.status,
    ).toBe("invalid");
    expect(
      snapshot.artifacts.find((entry) => entry.path === "governance/capabilities/broken.json")
        ?.status,
    ).toBe("invalid");
  });

  it("uses the full large-file set for domain summaries even when hotspots are truncated", async () => {
    const root = await makeRepoFixture({
      extraFiles: [
        { path: "src/large.ts", content: makeLargeFile(620) },
        { path: "ui/large.ts", content: makeLargeFile(610) },
      ],
    });

    const snapshot = await scanGovernanceSnapshot({
      repoRoot: root,
      config: {
        enabled: true,
        refreshIntervalMs: 1000,
        largeFileLineThreshold: 500,
        hotspotLimit: 1,
        codePaths: ["src", "ui"],
      },
    });

    expect(snapshot.hotspots).toHaveLength(1);
    expect(snapshot.summary.largeFileCount).toBe(2);
    expect(snapshot.domains.find((entry) => entry.id === "core")?.largeFileCount).toBe(1);
    expect(snapshot.domains.find((entry) => entry.id === "ui")?.largeFileCount).toBe(1);
  });

  it("ignores generated dist output during filesystem fallback", async () => {
    const root = await makeRepoFixture({
      extraFiles: [
        { path: "src/large.ts", content: makeLargeFile(620) },
        { path: "dist/generated.ts", content: makeLargeFile(5000) },
      ],
    });

    const originalPath = process.env.PATH;
    process.env.PATH = "/definitely-missing";
    try {
      const snapshot = await scanGovernanceSnapshot({
        repoRoot: root,
        config: {
          enabled: true,
          refreshIntervalMs: 1000,
          largeFileLineThreshold: 500,
          hotspotLimit: 10,
          codePaths: ["src", "dist"],
        },
      });

      expect(snapshot.summary.largeFileCount).toBe(1);
      expect(snapshot.hotspots[0]?.path).toBe("src/large.ts");
      expect(snapshot.hotspots.some((entry) => entry.path.startsWith("dist/"))).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("tracks scan duration and analyzed file count in the snapshot summary", async () => {
    const root = await makeRepoFixture({
      extraFiles: [{ path: "src/large.ts", content: makeLargeFile(620) }],
    });

    const snapshot = await scanGovernanceSnapshot({
      repoRoot: root,
      config: {
        enabled: true,
        refreshIntervalMs: 1000,
        largeFileLineThreshold: 500,
        hotspotLimit: 10,
        codePaths: ["src", "ui"],
      },
    });

    expect(snapshot.summary.analyzedFileCount).toBeGreaterThanOrEqual(3);
    expect(snapshot.summary.scanDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("lowers the score as large-file debt grows", async () => {
    const smallDebtRoot = await makeRepoFixture({
      extraFiles: Array.from({ length: 5 }, (_, index) => ({
        path: `src/large-${index}.ts`,
        content: makeLargeFile(520),
      })),
    });
    const largeDebtRoot = await makeRepoFixture({
      extraFiles: Array.from({ length: 40 }, (_, index) => ({
        path: `src/large-${index}.ts`,
        content: makeLargeFile(520),
      })),
    });

    const [smallDebt, largeDebt] = await Promise.all([
      scanGovernanceSnapshot({
        repoRoot: smallDebtRoot,
        config: {
          enabled: true,
          refreshIntervalMs: 1000,
          largeFileLineThreshold: 500,
          hotspotLimit: 10,
          codePaths: ["src"],
        },
      }),
      scanGovernanceSnapshot({
        repoRoot: largeDebtRoot,
        config: {
          enabled: true,
          refreshIntervalMs: 1000,
          largeFileLineThreshold: 500,
          hotspotLimit: 10,
          codePaths: ["src"],
        },
      }),
    ]);

    expect(smallDebt.summary.largeFileCount).toBe(5);
    expect(largeDebt.summary.largeFileCount).toBe(40);
    expect(largeDebt.summary.score).toBeLessThan(smallDebt.summary.score);
  });
});
