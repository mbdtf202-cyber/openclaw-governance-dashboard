#!/usr/bin/env node

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const [, , targetArg, ...rest] = process.argv;
const force = rest.includes("--force");

if (!targetArg) {
  console.error("Usage: node scripts/scaffold-governance-skeleton.mjs <openclaw-repo> [--force]");
  process.exit(1);
}

const repoRoot = path.resolve(targetArg);
const scriptPath = fileURLToPath(import.meta.url);
const templateRoot = path.resolve(path.dirname(scriptPath), "..", "templates");

async function copyRecursive(sourceDir, targetDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await fs.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(sourcePath, targetPath);
      continue;
    }
    if (!force) {
      try {
        await fs.access(targetPath);
        console.error(`Refusing to overwrite existing file: ${targetPath}`);
        process.exit(1);
      } catch {}
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

await copyRecursive(templateRoot, repoRoot);
console.log(`Governance skeleton copied into ${repoRoot}`);
