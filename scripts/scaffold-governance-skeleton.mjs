#!/usr/bin/env node

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const [, , targetArg, ...rest] = process.argv;
const force = rest.includes("--force");

if (!targetArg) {
  console.error("Usage: node scripts/scaffold-governance-skeleton.mjs <openclaw-repo> [--force]");
  process.exit(1);
}

const repoRoot = path.resolve(targetArg);
const scriptPath = fileURLToPath(import.meta.url);
const templateRoot = path.resolve(path.dirname(scriptPath), "..", "templates");
const execFileAsync = promisify(execFile);

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ensureLooksLikeOpenClawRepo(targetPath) {
  const packageJson = await readJsonFile(path.join(targetPath, "package.json"));
  const expectedDirs = ["src", "extensions", "ui"];
  const dirChecks = await Promise.all(
    expectedDirs.map(async (entry) => {
      try {
        const stat = await fs.stat(path.join(targetPath, entry));
        return stat.isDirectory();
      } catch {
        return false;
      }
    }),
  );

  const looksLikeOpenClaw = packageJson?.name === "openclaw" && dirChecks.every(Boolean);
  if (!looksLikeOpenClaw) {
    console.error(
      `Target does not look like an OpenClaw repository: ${targetPath}\nExpected package.json name "openclaw" plus src/, extensions/, and ui/.`,
    );
    process.exit(1);
  }
}

async function resolveOwnerToken(targetPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", targetPath, "remote", "get-url", "origin"]);
    const remote = stdout.trim();
    const match =
      remote.match(/github\.com[:/](?<owner>[^/]+)\/[^/]+(?:\.git)?$/i) ??
      remote.match(/github\.com\/(?<owner>[^/]+)\/[^/]+(?:\.git)?$/i);
    const owner = match?.groups?.owner?.trim();
    return owner ? `@${owner}` : "__OWNER__";
  } catch {
    return "__OWNER__";
  }
}

async function copyRecursive(sourceDir, targetDir) {
  const ownerToken = await resolveOwnerToken(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await fs.mkdir(targetDir, { recursive: true });
  const written = [];
  const skipped = [];

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await copyRecursive(sourcePath, targetPath);
      written.push(...nested.written);
      skipped.push(...nested.skipped);
      continue;
    }
    let exists = false;
    try {
      await fs.access(targetPath);
      exists = true;
    } catch {}
    if (exists && !force) {
      skipped.push(targetPath);
      continue;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (path.basename(targetPath) === "CODEOWNERS") {
      const template = await fs.readFile(sourcePath, "utf8");
      await fs.writeFile(targetPath, template.replaceAll("__OWNER__", ownerToken), "utf8");
    } else {
      await fs.copyFile(sourcePath, targetPath);
    }
    written.push(targetPath);
  }

  return { written, skipped };
}

await ensureLooksLikeOpenClawRepo(repoRoot);
const result = await copyRecursive(templateRoot, repoRoot);
console.log(`Governance skeleton synced into ${repoRoot}`);
console.log(`Written: ${result.written.length}`);
console.log(`Skipped existing: ${result.skipped.length}`);
