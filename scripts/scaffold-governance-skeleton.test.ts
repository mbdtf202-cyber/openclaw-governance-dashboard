import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const scriptPath = path.resolve(process.cwd(), "scripts", "scaffold-governance-skeleton.mjs");

async function makeTargetRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governance-scaffold-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "extensions"), { recursive: true });
  await fs.mkdir(path.join(root, "ui"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("scaffold-governance-skeleton", () => {
  it("rejects non-openclaw targets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-governance-bad-"));
    tempRoots.push(root);

    await expect(execFileAsync(process.execPath, [scriptPath, root])).rejects.toMatchObject({
      stderr: expect.stringContaining("does not look like an OpenClaw repository"),
    });
  });

  it("skips existing files without failing", async () => {
    const root = await makeTargetRepo();
    await fs.mkdir(path.join(root, "governance"), { recursive: true });
    await fs.writeFile(path.join(root, "governance", "domain-map.json"), "{}\n", "utf8");

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, root]);

    expect(stdout).toContain("Skipped existing:");
    const existing = await fs.readFile(path.join(root, "governance", "domain-map.json"), "utf8");
    expect(existing).toBe("{}\n");
    await fs.access(path.join(root, ".github", "labeler.yml"));
  });
});
