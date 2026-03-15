import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.ts";

const tempRoots: string[] = [];

async function makeRepoFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governance-plugin-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "extensions"), { recursive: true });
  await fs.mkdir(path.join(root, "ui"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "adr"), { recursive: true });
  await fs.mkdir(path.join(root, "governance", "capabilities"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf8");
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf8");
  await fs.writeFile(
    path.join(root, "governance", "domain-map.json"),
    JSON.stringify({ version: 1, domains: [{ id: "kernel", label: "Kernel", paths: ["src"] }] }),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "governance", "capabilities", "kernel.json"),
    JSON.stringify({ id: "kernel", label: "Kernel", paths: ["src"] }),
    "utf8",
  );
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("governance-dashboard plugin", () => {
  it("registers a service and serves governance.snapshot", async () => {
    const repoRoot = await makeRepoFixture();
    let service;
    let handler;

    plugin.register({
      pluginConfig: {},
      version: "0.1.1",
      source: path.join(repoRoot, "index.ts"),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerService: (entry) => {
        service = entry;
      },
      registerGatewayMethod: (method, entry) => {
        if (method === "governance.snapshot") {
          handler = entry;
        }
      },
    } as never);

    expect(service?.id).toBe("governance-dashboard");
    expect(typeof handler).toBe("function");

    await service.start({ workspaceDir: repoRoot, stateDir: path.join(repoRoot, ".state") });

    let response;
    await handler({
      params: { force: true },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });

    expect(response?.ok).toBe(true);
    expect(response?.payload?.available).toBe(true);
    expect(response?.payload?.snapshot?.summary?.domainCount).toBe(1);

    await service.stop?.({ workspaceDir: repoRoot, stateDir: path.join(repoRoot, ".state") });
  });
});
