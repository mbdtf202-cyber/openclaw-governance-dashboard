import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  GovernanceArtifact,
  GovernanceCapabilityRecord,
  GovernanceDomainRecord,
  GovernanceDomainSummary,
  GovernanceGuardrail,
  GovernanceHotspot,
  GovernanceIssue,
  GovernancePluginConfig,
  GovernanceSnapshot,
  GovernanceSummaryCard,
} from "./types.js";

type Logger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type GovernanceDomainMapFile = {
  version?: number;
  domains?: GovernanceDomainRecord[];
};

const FILE_ANALYSIS_RE = /\.(?:[cm]?js|ts|tsx)$/i;
const DOC_PAGE_RE = /^docs\/.*\.(?:md|mdx)$/i;
const ADR_PAGE_RE = /^docs\/adr\/.*\.md$/i;
const CAPABILITY_RE = /^governance\/capabilities\/.*\.json$/i;
const DEFAULT_SCRIPT_ARTIFACTS = [
  "scripts/check-channel-agnostic-boundaries.mjs",
  "scripts/check-ts-max-loc.ts",
];

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listDirNames(targetPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function toPosixPath(relativePath: string): string {
  return relativePath.replaceAll(path.sep, "/");
}

function looksLikeOpenClawRepo(packageName: unknown, dirEntries: Set<string>): boolean {
  return (
    packageName === "openclaw" &&
    dirEntries.has("src") &&
    dirEntries.has("extensions") &&
    dirEntries.has("ui")
  );
}

async function isOpenClawRepoRoot(candidate: string): Promise<boolean> {
  const packageJson = await readJsonFile<{ name?: string }>(path.join(candidate, "package.json"));
  const dirNames = new Set(await listDirNames(candidate));
  if (looksLikeOpenClawRepo(packageJson?.name, dirNames)) {
    return true;
  }
  return (await pathExists(path.join(candidate, "pnpm-workspace.yaml"))) && dirNames.has("src");
}

export async function resolveOpenClawRepoRoot(params: {
  configuredRepoRoot?: string;
  workspaceDir?: string;
  pluginSourcePath?: string;
}): Promise<string | null> {
  const candidates = [
    params.configuredRepoRoot,
    params.workspaceDir,
    process.cwd(),
    params.pluginSourcePath ? path.dirname(params.pluginSourcePath) : undefined,
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);

  for (const candidate of candidates) {
    let cursor = path.resolve(candidate);
    for (let depth = 0; depth < 8; depth += 1) {
      if (await isOpenClawRepoRoot(cursor)) {
        return cursor;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }

  return null;
}

async function walkFiles(rootDir: string, relativeDir = ""): Promise<string[]> {
  const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name.startsWith(".DS_Store")
    ) {
      continue;
    }
    const nextRelative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(rootDir, nextRelative)));
      continue;
    }
    if (entry.isFile()) {
      results.push(toPosixPath(nextRelative));
    }
  }

  return results;
}

async function listRepoFiles(repoRoot: string): Promise<string[]> {
  try {
    const stdout = execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return await walkFiles(repoRoot);
  }
}

function shouldAnalyzeFile(relativePath: string, focusPaths: string[]): boolean {
  if (!FILE_ANALYSIS_RE.test(relativePath)) {
    return false;
  }
  return focusPaths.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function categorizePath(relativePath: string): string {
  if (relativePath.startsWith("extensions/")) {
    return "extension";
  }
  if (relativePath.startsWith("ui/")) {
    return "ui";
  }
  if (relativePath.startsWith("src/")) {
    return "core";
  }
  if (relativePath.startsWith("scripts/")) {
    return "script";
  }
  if (relativePath.startsWith("docs/")) {
    return "docs";
  }
  return "other";
}

async function countFileLines(filePath: string): Promise<number> {
  const content = await fs.readFile(filePath, "utf8");
  if (!content) {
    return 0;
  }
  let lines = 1;
  for (const char of content) {
    if (char === "\n") {
      lines += 1;
    }
  }
  return lines;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

async function collectHotspots(
  repoRoot: string,
  files: string[],
  threshold: number,
  limit: number,
): Promise<{
  hotspots: GovernanceHotspot[];
  totalLargeFileCount: number;
  maxFileLines: number;
}> {
  const analyzed = await mapWithConcurrency(files, 24, async (relativePath) => ({
    path: relativePath,
    lines: await countFileLines(path.join(repoRoot, relativePath)),
    category: categorizePath(relativePath),
  }));

  const filtered = analyzed
    .filter((entry) => entry.lines >= threshold)
    .toSorted((a, b) => b.lines - a.lines);

  return {
    hotspots: filtered.slice(0, limit),
    totalLargeFileCount: filtered.length,
    maxFileLines: filtered[0]?.lines ?? 0,
  };
}

function summarizeGuardrails(params: {
  repoFiles: string[];
  adrCount: number;
  capabilityCount: number;
  domainCount: number;
}): GovernanceGuardrail[] {
  const repoFileSet = new Set(params.repoFiles);
  return [
    {
      id: "codeowners",
      label: "CODEOWNERS",
      status: repoFileSet.has(".github/CODEOWNERS") ? "ok" : "missing",
      detail: repoFileSet.has(".github/CODEOWNERS")
        ? "Ownership routing is present."
        : "Missing .github/CODEOWNERS, so review routing is not codified yet.",
    },
    {
      id: "labeler",
      label: "Labeler",
      status: repoFileSet.has(".github/labeler.yml") ? "ok" : "missing",
      detail: repoFileSet.has(".github/labeler.yml")
        ? "Changed-file labeling is wired."
        : "Missing .github/labeler.yml, so surface ownership is harder to automate.",
    },
    {
      id: "adr",
      label: "ADR Registry",
      status: params.adrCount > 0 ? "ok" : "missing",
      detail:
        params.adrCount > 0
          ? `${params.adrCount} ADR file(s) detected under docs/adr.`
          : "No ADRs detected under docs/adr.",
    },
    {
      id: "domain-map",
      label: "Domain Map",
      status: params.domainCount > 0 ? "ok" : "missing",
      detail:
        params.domainCount > 0
          ? `${params.domainCount} governance domain(s) detected.`
          : "No governance/domain-map.json domains detected.",
    },
    {
      id: "capabilities",
      label: "Capability Registry",
      status: params.capabilityCount > 0 ? "ok" : "missing",
      detail:
        params.capabilityCount > 0
          ? `${params.capabilityCount} capability file(s) detected.`
          : "No capability registry files detected under governance/capabilities.",
    },
    {
      id: "large-file-budget",
      label: "Large File Budget",
      status: repoFileSet.has("scripts/check-ts-max-loc.ts") ? "ok" : "warn",
      detail: repoFileSet.has("scripts/check-ts-max-loc.ts")
        ? "Line-count budget script exists."
        : "Missing scripts/check-ts-max-loc.ts; file-size drift has no automated guard.",
    },
    {
      id: "channel-boundaries",
      label: "Channel Boundary Guard",
      status: repoFileSet.has("scripts/check-channel-agnostic-boundaries.mjs") ? "ok" : "warn",
      detail: repoFileSet.has("scripts/check-channel-agnostic-boundaries.mjs")
        ? "Cross-channel boundary guard exists."
        : "Missing scripts/check-channel-agnostic-boundaries.mjs.",
    },
  ];
}

function buildArtifacts(params: {
  repoFiles: string[];
  capabilityFiles: string[];
  adrFiles: string[];
}): GovernanceArtifact[] {
  const artifacts: GovernanceArtifact[] = [];
  if (params.repoFiles.includes("governance/domain-map.json")) {
    artifacts.push({
      id: "domain-map",
      label: "Domain Map",
      path: "governance/domain-map.json",
      kind: "domain-map",
    });
  }
  for (const file of params.capabilityFiles) {
    artifacts.push({
      id: `capability:${file}`,
      label: path.basename(file, path.extname(file)),
      path: file,
      kind: "capability",
    });
  }
  for (const file of params.adrFiles.slice(0, 6)) {
    artifacts.push({
      id: `adr:${file}`,
      label: path.basename(file, path.extname(file)),
      path: file,
      kind: "adr",
    });
  }
  for (const script of DEFAULT_SCRIPT_ARTIFACTS.filter((entry) =>
    params.repoFiles.includes(entry),
  )) {
    artifacts.push({
      id: `script:${script}`,
      label: path.basename(script, path.extname(script)),
      path: script,
      kind: "script",
    });
  }
  return artifacts;
}

function calculateScore(params: {
  guardrails: GovernanceGuardrail[];
  issues: GovernanceIssue[];
  largeFileCount: number;
  unownedDomainCount: number;
  unownedCapabilityCount: number;
}): number {
  let score = 100;
  for (const guardrail of params.guardrails) {
    if (guardrail.status === "missing") {
      score -= 10;
    } else if (guardrail.status === "warn") {
      score -= 4;
    }
  }
  score -= Math.min(20, params.largeFileCount * 2);
  score -= Math.min(16, params.unownedDomainCount * 4);
  score -= Math.min(12, params.unownedCapabilityCount * 3);
  score -= params.issues.filter((issue) => issue.severity === "high").length * 2;
  return Math.max(0, Math.min(100, score));
}

function buildCards(params: {
  score: number;
  extensionCount: number;
  capabilityCount: number;
  domainCount: number;
  adrCount: number;
  largeFileCount: number;
}): GovernanceSummaryCard[] {
  return [
    {
      id: "score",
      label: "Governance score",
      value: `${params.score}/100`,
      helper: "Higher is better",
      tone: params.score >= 80 ? "ok" : params.score >= 60 ? "warn" : "alert",
    },
    {
      id: "domains",
      label: "Domains",
      value: String(params.domainCount),
      helper: "Bounded contexts in governance/domain-map.json",
    },
    {
      id: "capabilities",
      label: "Capabilities",
      value: String(params.capabilityCount),
      helper: "Machine-readable ownership units",
    },
    {
      id: "adrs",
      label: "ADRs",
      value: String(params.adrCount),
      helper: "Decision records under docs/adr",
    },
    {
      id: "extensions",
      label: "Extensions",
      value: String(params.extensionCount),
      helper: "Top-level extension packages",
    },
    {
      id: "hotspots",
      label: "Large files",
      value: String(params.largeFileCount),
      helper: "Files over the configured threshold",
      tone: params.largeFileCount === 0 ? "ok" : params.largeFileCount <= 5 ? "warn" : "alert",
    },
  ];
}

function buildIssues(params: {
  guardrails: GovernanceGuardrail[];
  hotspots: GovernanceHotspot[];
  largeFileCount: number;
  domains: GovernanceDomainRecord[];
  capabilities: GovernanceCapabilityRecord[];
}): GovernanceIssue[] {
  const issues: GovernanceIssue[] = [];
  const codeowners = params.guardrails.find((entry) => entry.id === "codeowners");
  if (codeowners?.status === "missing") {
    issues.push({
      id: "missing-codeowners",
      severity: "high",
      title: "CODEOWNERS is missing",
      detail: "Review routing is not codified, so boundary changes can bypass area ownership.",
      path: ".github/CODEOWNERS",
      action: "Create a first-pass CODEOWNERS file for kernel, channels, UI, and extensions.",
    });
  }
  if (params.largeFileCount > 0 && params.hotspots.length > 0) {
    const hottest = params.hotspots[0];
    issues.push({
      id: "large-file-drift",
      severity: params.largeFileCount > 5 ? "high" : "medium",
      title: "Large-file drift is active",
      detail: `${params.largeFileCount} file(s) are above the configured line budget. The largest is ${hottest.path} at ${hottest.lines} lines.`,
      path: hottest.path,
      action: "Split oversized files by bounded context before adding more behavior.",
    });
  }

  const unownedDomains = params.domains.filter(
    (entry) => !entry.owners || entry.owners.length === 0,
  );
  if (unownedDomains.length > 0) {
    issues.push({
      id: "unowned-domains",
      severity: "medium",
      title: "Domain ownership is incomplete",
      detail: `${unownedDomains.length} domain(s) in governance/domain-map.json do not declare owners.`,
      path: "governance/domain-map.json",
      action: "Assign at least one owner or team alias to every domain boundary.",
    });
  }

  const unownedCapabilities = params.capabilities.filter(
    (entry) => !entry.owners || entry.owners.length === 0,
  );
  if (unownedCapabilities.length > 0) {
    issues.push({
      id: "unowned-capabilities",
      severity: "low",
      title: "Capability registry has unassigned entries",
      detail: `${unownedCapabilities.length} capability file(s) have no owners yet.`,
      path: "governance/capabilities",
      action:
        "Attach capability ownership before using the registry as a reviewer source of truth.",
    });
  }

  return issues;
}

function summarizeDomains(params: {
  domains: GovernanceDomainRecord[];
  repoFiles: string[];
  hotspots: GovernanceHotspot[];
}): GovernanceDomainSummary[] {
  return params.domains.map((domain) => {
    const fileCount = params.repoFiles.filter((file) =>
      domain.paths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
    ).length;
    const largeFileCount = params.hotspots.filter((entry) =>
      domain.paths.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)),
    ).length;
    const issueCount = (domain.owners && domain.owners.length > 0 ? 0 : 1) + largeFileCount;
    return {
      id: domain.id,
      label: domain.label,
      description: domain.description,
      maturity: domain.maturity,
      owners: domain.owners ?? [],
      paths: domain.paths,
      fileCount,
      largeFileCount,
      issueCount,
    };
  });
}

export async function scanGovernanceSnapshot(params: {
  repoRoot: string;
  config: GovernancePluginConfig;
  log?: Logger;
}): Promise<GovernanceSnapshot> {
  const repoFiles = await listRepoFiles(params.repoRoot);
  const repoFileSet = new Set(repoFiles);
  const tsFiles = repoFiles.filter((file) => /\.(?:ts|tsx)$/i.test(file)).length;
  const docsPages = repoFiles.filter((file) => DOC_PAGE_RE.test(file)).length;
  const adrFiles = repoFiles.filter((file) => ADR_PAGE_RE.test(file));
  const capabilityFiles = repoFiles.filter((file) => CAPABILITY_RE.test(file));
  const extensionDirs = await listDirNames(path.join(params.repoRoot, "extensions"));
  const domainMap =
    (await readJsonFile<GovernanceDomainMapFile>(
      path.join(params.repoRoot, "governance", "domain-map.json"),
    )) ?? {};
  const domains = Array.isArray(domainMap.domains) ? domainMap.domains : [];
  const capabilities = (
    await Promise.all(
      capabilityFiles.map(async (relativePath) => {
        const absolutePath = path.join(params.repoRoot, relativePath);
        return (await readJsonFile<GovernanceCapabilityRecord>(absolutePath)) ?? null;
      }),
    )
  ).filter((entry): entry is GovernanceCapabilityRecord => Boolean(entry));

  const analyzedFiles = repoFiles.filter((file) =>
    shouldAnalyzeFile(file, params.config.focusPaths),
  );
  params.log?.info?.(
    `[governance-dashboard] scanning ${analyzedFiles.length} source file(s) from ${params.repoRoot}`,
  );
  const hotspotSummary = await collectHotspots(
    params.repoRoot,
    analyzedFiles,
    params.config.largeFileLineThreshold,
    params.config.hotspotLimit,
  );
  const hotspots = hotspotSummary.hotspots;
  const guardrails = summarizeGuardrails({
    repoFiles,
    adrCount: adrFiles.length,
    capabilityCount: capabilityFiles.length,
    domainCount: domains.length,
  });
  const issues = buildIssues({
    guardrails,
    hotspots,
    largeFileCount: hotspotSummary.totalLargeFileCount,
    domains,
    capabilities,
  });
  const unownedDomainCount = domains.filter(
    (entry) => !entry.owners || entry.owners.length === 0,
  ).length;
  const unownedCapabilityCount = capabilities.filter(
    (entry) => !entry.owners || entry.owners.length === 0,
  ).length;
  const score = calculateScore({
    guardrails,
    issues,
    largeFileCount: hotspotSummary.totalLargeFileCount,
    unownedDomainCount,
    unownedCapabilityCount,
  });

  return {
    generatedAt: new Date().toISOString(),
    repoRoot: params.repoRoot,
    summary: {
      totalFiles: repoFiles.length,
      tsFiles,
      extensions: extensionDirs.length,
      docsPages,
      adrCount: adrFiles.length,
      capabilityCount: capabilityFiles.length,
      domainCount: domains.length,
      largeFileCount: hotspotSummary.totalLargeFileCount,
      maxFileLines: hotspotSummary.maxFileLines,
      score,
    },
    cards: buildCards({
      score,
      extensionCount: extensionDirs.length,
      capabilityCount: capabilityFiles.length,
      domainCount: domains.length,
      adrCount: adrFiles.length,
      largeFileCount: hotspotSummary.totalLargeFileCount,
    }),
    guardrails,
    issues,
    hotspots,
    domains: summarizeDomains({ domains, repoFiles, hotspots }),
    artifacts: buildArtifacts({ repoFiles, capabilityFiles, adrFiles }),
  };
}
