import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenClawRepoRoot, scanGovernanceSnapshot } from "./scanner.js";

const tempRoots: string[] = [];

async function makeRepoFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governance-"));
  tempRoots.push(root);

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "extensions"), { recursive: true });
  await fs.mkdir(path.join(root, "ui"), { recursive: true });
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
  await fs.writeFile(path.join(root, "docs", "adr", "0001.md"), "# ADR\n", "utf8");
  await fs.writeFile(
    path.join(root, "governance", "domain-map.json"),
    JSON.stringify(
      {
        version: 1,
        domains: [
          {
            id: "kernel",
            label: "Kernel",
            owners: ["team:platform"],
            paths: ["src"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "governance", "capabilities", "kernel.json"),
    JSON.stringify(
      {
        id: "kernel",
        label: "Kernel",
        owners: ["team:platform"],
        paths: ["src"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(root, "src", "small.ts"), "export const x = 1;\n", "utf8");
  await fs.writeFile(
    path.join(root, "src", "large.ts"),
    `${Array.from({ length: 620 }, (_, index) => `export const line${index} = ${index};`).join("\n")}\n`,
    "utf8",
  );

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
  it("reports hotspots and missing codeowners", async () => {
    const root = await makeRepoFixture();

    const snapshot = await scanGovernanceSnapshot({
      repoRoot: root,
      config: {
        enabled: true,
        refreshIntervalMs: 1000,
        largeFileLineThreshold: 500,
        hotspotLimit: 10,
        focusPaths: ["src", "extensions", "ui"],
      },
    });

    expect(snapshot.summary.domainCount).toBe(1);
    expect(snapshot.summary.capabilityCount).toBe(1);
    expect(snapshot.summary.largeFileCount).toBe(1);
    expect(snapshot.hotspots[0]?.path).toBe("src/large.ts");
    expect(snapshot.guardrails.find((entry) => entry.id === "codeowners")?.status).toBe("missing");
    expect(snapshot.issues.some((entry) => entry.id === "missing-codeowners")).toBe(true);
  });

  it("counts domain large files using the full hotspot set, not only the display limit", async () => {
    const root = await makeRepoFixture();
    await fs.writeFile(
      path.join(root, "governance", "domain-map.json"),
      JSON.stringify(
        {
          version: 1,
          domains: [
            { id: "kernel", label: "Kernel", owners: ["team:platform"], paths: ["src"] },
            { id: "ui", label: "UI", owners: ["team:ux"], paths: ["ui"] },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.mkdir(path.join(root, "src", "kernel"), { recursive: true });
    await fs.mkdir(path.join(root, "ui"), { recursive: true });
    for (const filePath of [
      path.join(root, "src", "kernel", "a.ts"),
      path.join(root, "src", "kernel", "b.ts"),
      path.join(root, "ui", "a.ts"),
    ]) {
      await fs.writeFile(
        filePath,
        `${Array.from({ length: 620 }, (_, index) => `export const line${index} = ${index};`).join("\n")}\n`,
        "utf8",
      );
    }

    const snapshot = await scanGovernanceSnapshot({
      repoRoot: root,
      config: {
        enabled: true,
        refreshIntervalMs: 1000,
        largeFileLineThreshold: 500,
        hotspotLimit: 1,
        focusPaths: ["src", "ui"],
      },
    });

    expect(snapshot.summary.largeFileCount).toBe(4);
    const kernel = snapshot.domains.find((entry) => entry.id === "kernel");
    const ui = snapshot.domains.find((entry) => entry.id === "ui");
    expect(kernel?.largeFileCount).toBe(3);
    expect(ui?.largeFileCount).toBe(1);
  });
});
