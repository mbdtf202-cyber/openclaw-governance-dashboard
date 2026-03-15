import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  domains?: unknown;
};

type JsonReadResult<T> =
  | { status: "missing" }
  | { status: "invalid"; error: string }
  | { status: "ok"; value: T };

type DomainMapState = {
  status: "missing" | "invalid" | "ok";
  domains: GovernanceDomainRecord[];
  detail: string;
  invalidEntryCount: number;
};

type CapabilityRegistryState = {
  status: "missing" | "invalid" | "ok";
  capabilities: GovernanceCapabilityRecord[];
  validFiles: string[];
  invalidFiles: Array<{ path: string; error: string }>;
  detail: string;
};

type AdrRegistryState = {
  status: "missing" | "invalid" | "ok";
  files: string[];
  detail: string;
};

type RepoFingerprint = {
  value: string;
  mode: "git" | "filesystem";
  inputCount: number;
};

type DomainCoverageState = {
  fileCountById: Map<string, number>;
  largeFileCountById: Map<string, number>;
  issueCountById: Map<string, number>;
  overlappingFiles: Array<{ path: string; domains: string[] }>;
  uncoveredFiles: string[];
  missingCodeownersPaths: Array<{ domainId: string; path: string }>;
};

type CapabilityAlignmentState = {
  missingPathCapabilities: GovernanceCapabilityRecord[];
  unmappedPaths: Array<{ capability: GovernanceCapabilityRecord; path: string }>;
  ownerMismatches: Array<{
    capability: GovernanceCapabilityRecord;
    domains: GovernanceDomainRecord[];
  }>;
};

const CODE_FILE_RE = /\.(?:[cm]?js|ts|tsx)$/i;
const DOC_PAGE_RE = /^docs\/.*\.(?:md|mdx)$/i;
const ADR_DOC_RE = /^docs\/adr\/.*\.md$/i;
const ADR_RECORD_RE = /^docs\/adr\/\d{4}.*\.md$/i;
const CAPABILITY_RE = /^governance\/capabilities\/.*\.json$/i;
const GENERATED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".cache",
  ".turbo",
  ".next",
  ".output",
  "out",
  "build",
]);
const DEFAULT_SCRIPT_ARTIFACTS = [
  "scripts/check-channel-agnostic-boundaries.mjs",
  "scripts/check-ts-max-loc.ts",
];
const GOVERNANCE_SIGNAL_PATHS = new Set([
  ".github/CODEOWNERS",
  ".github/labeler.yml",
  "governance/domain-map.json",
  ...DEFAULT_SCRIPT_ARTIFACTS,
]);

function cleanErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function toPosixPath(relativePath: string): string {
  return relativePath.replaceAll(path.sep, "/");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function normalizeOwners(value: unknown): string[] {
  return normalizeStringArray(value);
}

function pathMatchesPrefix(candidatePath: string, prefix: string): boolean {
  const normalizedPrefix = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedPrefix) {
    return false;
  }
  return candidatePath === normalizedPrefix || candidatePath.startsWith(`${normalizedPrefix}/`);
}

function sameOwners(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftSet = new Set((left ?? []).filter(Boolean));
  const rightSet = new Set((right ?? []).filter(Boolean));
  if (leftSet.size !== rightSet.size) {
    return false;
  }
  return [...leftSet].every((entry) => rightSet.has(entry));
}

function bumpCount(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<JsonReadResult<T>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return {
      status: "ok",
      value: JSON.parse(raw) as T,
    };
  } catch (error) {
    const code = typeof error === "object" && error ? (error as NodeJS.ErrnoException).code : null;
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "invalid",
      error: cleanErrorMessage(error),
    };
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
  if (packageJson.status === "ok" && looksLikeOpenClawRepo(packageJson.value?.name, dirNames)) {
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
    if (entry.name.startsWith(".DS_Store")) {
      continue;
    }
    const nextRelative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (GENERATED_DIRS.has(entry.name)) {
        continue;
      }
      results.push(...(await walkFiles(rootDir, nextRelative)));
      continue;
    }
    if (entry.isFile()) {
      results.push(toPosixPath(nextRelative));
    }
  }

  return results;
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function listRepoFiles(
  repoRoot: string,
  options?: { preferGit?: boolean },
): Promise<string[]> {
  const preferGit = options?.preferGit !== false;
  if (preferGit) {
    try {
      const stdout = runGit(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard"]);
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      // Fall through to filesystem discovery.
    }
  }
  return await walkFiles(repoRoot);
}

function shouldAnalyzeFile(relativePath: string, codePaths: string[]): boolean {
  if (!CODE_FILE_RE.test(relativePath)) {
    return false;
  }
  return codePaths.some((prefix) => pathMatchesPrefix(relativePath, prefix));
}

function shouldFingerprintPath(relativePath: string, codePaths: string[]): boolean {
  return (
    GOVERNANCE_SIGNAL_PATHS.has(relativePath) ||
    CAPABILITY_RE.test(relativePath) ||
    ADR_DOC_RE.test(relativePath) ||
    shouldAnalyzeFile(relativePath, codePaths)
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
  try {
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
  } catch {
    return 0;
  }
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
  largeFiles: GovernanceHotspot[];
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
    .toSorted((left, right) => right.lines - left.lines);

  return {
    hotspots: filtered.slice(0, limit),
    largeFiles: filtered,
    totalLargeFileCount: filtered.length,
    maxFileLines: filtered[0]?.lines ?? 0,
  };
}

function validateDomainRecord(entry: unknown): GovernanceDomainRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const paths = normalizeStringArray(record.paths);
  if (!id || !label || paths.length === 0) {
    return null;
  }
  return {
    id,
    label,
    description: typeof record.description === "string" ? record.description.trim() : undefined,
    maturity:
      record.maturity === "experimental" ||
      record.maturity === "supported" ||
      record.maturity === "stable" ||
      record.maturity === "deprecated"
        ? record.maturity
        : undefined,
    owners: normalizeOwners(record.owners),
    paths,
  };
}

function validateCapabilityRecord(entry: unknown): GovernanceCapabilityRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!id || !label) {
    return null;
  }
  const paths = normalizeStringArray(record.paths);
  return {
    id,
    label,
    description: typeof record.description === "string" ? record.description.trim() : undefined,
    owners: normalizeOwners(record.owners),
    paths: paths.length > 0 ? paths : undefined,
    maturity:
      record.maturity === "experimental" ||
      record.maturity === "supported" ||
      record.maturity === "stable" ||
      record.maturity === "deprecated"
        ? record.maturity
        : undefined,
  };
}

function summarizeDomainMapState(file: JsonReadResult<GovernanceDomainMapFile>): DomainMapState {
  if (file.status === "missing") {
    return {
      status: "missing",
      domains: [],
      detail: "Missing governance/domain-map.json.",
      invalidEntryCount: 0,
    };
  }
  if (file.status === "invalid") {
    return {
      status: "invalid",
      domains: [],
      detail: `governance/domain-map.json could not be parsed: ${file.error}`,
      invalidEntryCount: 0,
    };
  }

  const rawDomains = Array.isArray(file.value.domains) ? file.value.domains : [];
  const domains = rawDomains.map((entry) => validateDomainRecord(entry)).filter(Boolean);
  const invalidEntryCount = rawDomains.length - domains.length;

  if (domains.length === 0) {
    return {
      status: "invalid",
      domains: [],
      detail: "governance/domain-map.json exists but does not declare any valid domains.",
      invalidEntryCount,
    };
  }

  if (invalidEntryCount > 0) {
    return {
      status: "invalid",
      domains,
      detail: `governance/domain-map.json contains ${invalidEntryCount} invalid domain entr${invalidEntryCount === 1 ? "y" : "ies"}.`,
      invalidEntryCount,
    };
  }

  return {
    status: "ok",
    domains,
    detail: `${domains.length} governance domain(s) detected.`,
    invalidEntryCount: 0,
  };
}

async function summarizeCapabilityRegistryState(
  repoRoot: string,
  capabilityFiles: string[],
): Promise<CapabilityRegistryState> {
  if (capabilityFiles.length === 0) {
    return {
      status: "missing",
      capabilities: [],
      validFiles: [],
      invalidFiles: [],
      detail: "No capability registry files detected under governance/capabilities.",
    };
  }

  const loaded = await Promise.all(
    capabilityFiles.map(async (relativePath) => {
      const absolutePath = path.join(repoRoot, relativePath);
      const parsed = await readJsonFile<GovernanceCapabilityRecord>(absolutePath);
      if (parsed.status === "missing") {
        return {
          path: relativePath,
          record: null,
          error: "file disappeared during scan",
        };
      }
      if (parsed.status === "invalid") {
        return {
          path: relativePath,
          record: null,
          error: parsed.error,
        };
      }
      const record = validateCapabilityRecord(parsed.value);
      if (!record) {
        return {
          path: relativePath,
          record: null,
          error: "missing required id/label fields",
        };
      }
      return {
        path: relativePath,
        record,
        error: null,
      };
    }),
  );

  const capabilities = loaded
    .map((entry) => entry.record)
    .filter((entry): entry is GovernanceCapabilityRecord => Boolean(entry));
  const validFiles = loaded.filter((entry) => entry.record).map((entry) => entry.path);
  const invalidFiles = loaded
    .filter((entry) => entry.error)
    .map((entry) => ({
      path: entry.path,
      error: entry.error ?? "invalid capability file",
    }));

  if (capabilities.length === 0) {
    return {
      status: "invalid",
      capabilities: [],
      validFiles,
      invalidFiles,
      detail: "Capability registry files exist, but none could be validated.",
    };
  }

  if (invalidFiles.length > 0) {
    return {
      status: "invalid",
      capabilities,
      validFiles,
      invalidFiles,
      detail: `${capabilities.length} valid capability file(s) detected, ${invalidFiles.length} invalid file(s) need fixes.`,
    };
  }

  return {
    status: "ok",
    capabilities,
    validFiles,
    invalidFiles: [],
    detail: `${capabilities.length} capability file(s) detected.`,
  };
}

function summarizeAdrRegistryState(repoFiles: string[]): AdrRegistryState {
  const adrDocs = repoFiles.filter((file) => ADR_DOC_RE.test(file));
  const adrRecords = repoFiles.filter((file) => ADR_RECORD_RE.test(file));
  if (adrDocs.length === 0) {
    return {
      status: "missing",
      files: [],
      detail: "No ADRs detected under docs/adr.",
    };
  }
  if (adrRecords.length === 0) {
    return {
      status: "invalid",
      files: [],
      detail: "docs/adr exists but does not contain any numbered ADR records yet.",
    };
  }
  return {
    status: "ok",
    files: adrRecords,
    detail: `${adrRecords.length} ADR file(s) detected under docs/adr.`,
  };
}

function summarizeGuardrails(params: {
  repoFiles: string[];
  adrState: AdrRegistryState;
  domainMapState: DomainMapState;
  capabilityState: CapabilityRegistryState;
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
      status: params.adrState.status,
      detail: params.adrState.detail,
    },
    {
      id: "domain-map",
      label: "Domain Map",
      status: params.domainMapState.status,
      detail: params.domainMapState.detail,
    },
    {
      id: "capabilities",
      label: "Capability Registry",
      status: params.capabilityState.status,
      detail: params.capabilityState.detail,
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
  adrState: AdrRegistryState;
  domainMapState: DomainMapState;
  capabilityState: CapabilityRegistryState;
}): GovernanceArtifact[] {
  const artifacts: GovernanceArtifact[] = [];

  if (params.repoFiles.includes("governance/domain-map.json")) {
    artifacts.push({
      id: "domain-map",
      label: "Domain Map",
      path: "governance/domain-map.json",
      kind: "domain-map",
      status: params.domainMapState.status === "invalid" ? "invalid" : "ok",
      detail: params.domainMapState.status === "invalid" ? params.domainMapState.detail : undefined,
    });
  }

  for (const file of params.capabilityState.validFiles) {
    artifacts.push({
      id: `capability:${file}`,
      label: path.basename(file, path.extname(file)),
      path: file,
      kind: "capability",
      status: "ok",
    });
  }

  for (const invalidFile of params.capabilityState.invalidFiles) {
    artifacts.push({
      id: `capability:${invalidFile.path}`,
      label: path.basename(invalidFile.path, path.extname(invalidFile.path)),
      path: invalidFile.path,
      kind: "capability",
      status: "invalid",
      detail: invalidFile.error,
    });
  }

  for (const file of params.adrState.files.slice(0, 6)) {
    artifacts.push({
      id: `adr:${file}`,
      label: path.basename(file, path.extname(file)),
      path: file,
      kind: "adr",
      status: "ok",
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
      status: "ok",
    });
  }

  return artifacts;
}

function scaleCountPenalty(count: number, maxPenalty: number, referenceCount = 500): number {
  if (count <= 0) {
    return 0;
  }
  const normalized = Math.log10(count + 1) / Math.log10(referenceCount + 1);
  return Math.min(maxPenalty, Math.round(maxPenalty * normalized));
}

function calculateScore(params: {
  guardrails: GovernanceGuardrail[];
  largeFileCount: number;
  unownedDomainCount: number;
  unownedCapabilityCount: number;
  uncoveredFileCount: number;
  overlappingDomainCount: number;
  capabilityMismatchCount: number;
}): number {
  let score = 100;
  for (const guardrail of params.guardrails) {
    if (guardrail.status === "missing") {
      score -= 10;
      continue;
    }
    if (guardrail.status === "invalid") {
      score -= 12;
      continue;
    }
    if (guardrail.status === "warn") {
      score -= 5;
    }
  }
  score -= scaleCountPenalty(params.largeFileCount, 35, 500);
  score -= scaleCountPenalty(params.unownedDomainCount, 10, 12);
  score -= scaleCountPenalty(params.unownedCapabilityCount, 8, 12);
  score -= scaleCountPenalty(params.uncoveredFileCount, 18, 400);
  score -= scaleCountPenalty(params.overlappingDomainCount, 12, 80);
  score -= scaleCountPenalty(params.capabilityMismatchCount, 12, 24);
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
      helper: "Validated entries in governance/domain-map.json",
    },
    {
      id: "capabilities",
      label: "Capabilities",
      value: String(params.capabilityCount),
      helper: "Validated capability registry entries",
    },
    {
      id: "adrs",
      label: "ADRs",
      value: String(params.adrCount),
      helper: "Numbered decision records under docs/adr",
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
      helper: "Code files over the configured threshold",
      tone: params.largeFileCount === 0 ? "ok" : params.largeFileCount <= 5 ? "warn" : "alert",
    },
  ];
}

function createGuardrailIssue(guardrail: GovernanceGuardrail): GovernanceIssue | null {
  if (guardrail.status === "ok") {
    return null;
  }

  switch (guardrail.id) {
    case "codeowners":
      return {
        id: "missing-codeowners",
        severity: "high",
        title: "CODEOWNERS is missing",
        detail: guardrail.detail,
        path: ".github/CODEOWNERS",
        action: "Create a first-pass CODEOWNERS file for kernel, channels, UI, and extensions.",
      };
    case "labeler":
      return {
        id: "missing-labeler",
        severity: "medium",
        title: "Labeler coverage is missing",
        detail: guardrail.detail,
        path: ".github/labeler.yml",
        action:
          "Wire changed-file labels so review ownership and release notes are easier to route.",
      };
    case "adr":
      return {
        id: guardrail.status === "invalid" ? "invalid-adr-registry" : "missing-adr-registry",
        severity: guardrail.status === "invalid" ? "medium" : "medium",
        title:
          guardrail.status === "invalid"
            ? "ADR registry is present but not usable"
            : "ADR registry is missing",
        detail: guardrail.detail,
        path: "docs/adr",
        action:
          "Add at least one numbered ADR and keep the registry usable as architectural history.",
      };
    case "domain-map":
      return {
        id: guardrail.status === "invalid" ? "invalid-domain-map" : "missing-domain-map",
        severity: "high",
        title: guardrail.status === "invalid" ? "Domain map is invalid" : "Domain map is missing",
        detail: guardrail.detail,
        path: "governance/domain-map.json",
        action:
          "Restore a valid governance/domain-map.json before relying on domain-level ownership signals.",
      };
    case "capabilities":
      return {
        id:
          guardrail.status === "invalid"
            ? "invalid-capability-registry"
            : "missing-capability-registry",
        severity: guardrail.status === "invalid" ? "medium" : "medium",
        title:
          guardrail.status === "invalid"
            ? "Capability registry is invalid"
            : "Capability registry is missing",
        detail: guardrail.detail,
        path: "governance/capabilities",
        action:
          "Make the capability registry parseable before using it as a governance source of truth.",
      };
    case "large-file-budget":
      return {
        id: "missing-large-file-budget",
        severity: "low",
        title: "Large-file budget guard is missing",
        detail: guardrail.detail,
        path: "scripts/check-ts-max-loc.ts",
        action: "Add an automated LOC budget guard so hotspots stop drifting silently.",
      };
    case "channel-boundaries":
      return {
        id: "missing-channel-boundary-guard",
        severity: "low",
        title: "Channel boundary guard is missing",
        detail: guardrail.detail,
        path: "scripts/check-channel-agnostic-boundaries.mjs",
        action: "Reinstate the shared-boundary guard before more cross-channel logic accumulates.",
      };
    default:
      return null;
  }
}

async function readCodeownersPatterns(repoRoot: string, repoFiles: string[]): Promise<Set<string>> {
  if (!repoFiles.includes(".github/CODEOWNERS")) {
    return new Set();
  }
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".github", "CODEOWNERS"), "utf8");
    const patterns = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split(/\s+/)[0] ?? "")
      .map((pattern) => pattern.replace(/^\/+/, "").replace(/\/+$/, ""))
      .filter((pattern) => pattern.length > 0 && !/[*?\[]/.test(pattern));
    return new Set(patterns);
  } catch {
    return new Set();
  }
}

function analyzeDomainCoverage(params: {
  repoFiles: string[];
  analyzedFiles: string[];
  largeFiles: GovernanceHotspot[];
  domains: GovernanceDomainRecord[];
  codeownersPatterns: Set<string>;
}): DomainCoverageState {
  const fileCountById = new Map<string, number>();
  const largeFileCountById = new Map<string, number>();
  const issueCountById = new Map<string, number>();

  for (const domain of params.domains) {
    fileCountById.set(domain.id, 0);
    largeFileCountById.set(domain.id, 0);
    issueCountById.set(domain.id, domain.owners && domain.owners.length > 0 ? 0 : 1);
  }

  for (const file of params.repoFiles) {
    for (const domain of params.domains) {
      if (domain.paths.some((prefix) => pathMatchesPrefix(file, prefix))) {
        bumpCount(fileCountById, domain.id);
      }
    }
  }

  for (const hotspot of params.largeFiles) {
    for (const domain of params.domains) {
      if (domain.paths.some((prefix) => pathMatchesPrefix(hotspot.path, prefix))) {
        bumpCount(largeFileCountById, domain.id);
        bumpCount(issueCountById, domain.id);
      }
    }
  }

  const uncoveredFiles: string[] = [];
  const overlappingFiles: Array<{ path: string; domains: string[] }> = [];

  for (const file of params.analyzedFiles) {
    const matches = params.domains
      .filter((domain) => domain.paths.some((prefix) => pathMatchesPrefix(file, prefix)))
      .map((domain) => domain.id);
    if (matches.length === 0) {
      uncoveredFiles.push(file);
      continue;
    }
    if (matches.length > 1) {
      overlappingFiles.push({ path: file, domains: matches });
      for (const domainId of matches) {
        bumpCount(issueCountById, domainId);
      }
    }
  }

  const missingCodeownersPaths: Array<{ domainId: string; path: string }> = [];
  if (params.codeownersPatterns.size > 0) {
    for (const domain of params.domains) {
      for (const domainPath of domain.paths) {
        if (!params.codeownersPatterns.has(domainPath)) {
          missingCodeownersPaths.push({ domainId: domain.id, path: domainPath });
          bumpCount(issueCountById, domain.id);
        }
      }
    }
  }

  return {
    fileCountById,
    largeFileCountById,
    issueCountById,
    overlappingFiles,
    uncoveredFiles,
    missingCodeownersPaths,
  };
}

function analyzeCapabilityAlignment(params: {
  capabilities: GovernanceCapabilityRecord[];
  domains: GovernanceDomainRecord[];
  issueCountByDomainId: Map<string, number>;
}): CapabilityAlignmentState {
  const missingPathCapabilities: GovernanceCapabilityRecord[] = [];
  const unmappedPaths: Array<{ capability: GovernanceCapabilityRecord; path: string }> = [];
  const ownerMismatches: Array<{
    capability: GovernanceCapabilityRecord;
    domains: GovernanceDomainRecord[];
  }> = [];

  for (const capability of params.capabilities) {
    const capabilityPaths = capability.paths ?? [];
    if (capabilityPaths.length === 0) {
      missingPathCapabilities.push(capability);
      continue;
    }

    const matchedDomainIds = new Set<string>();
    for (const capabilityPath of capabilityPaths) {
      const matchingDomains = params.domains.filter((domain) =>
        domain.paths.some((prefix) => pathMatchesPrefix(capabilityPath, prefix)),
      );
      if (matchingDomains.length === 0) {
        unmappedPaths.push({ capability, path: capabilityPath });
        continue;
      }
      for (const domain of matchingDomains) {
        matchedDomainIds.add(domain.id);
      }
    }

    const matchedDomains = params.domains.filter((domain) => matchedDomainIds.has(domain.id));
    const capabilityOwners = capability.owners ?? [];
    if (
      matchedDomains.length > 0 &&
      capabilityOwners.length > 0 &&
      matchedDomains.some((domain) => !sameOwners(capabilityOwners, domain.owners))
    ) {
      ownerMismatches.push({ capability, domains: matchedDomains });
      for (const domain of matchedDomains) {
        bumpCount(params.issueCountByDomainId, domain.id);
      }
    }
  }

  return {
    missingPathCapabilities,
    unmappedPaths,
    ownerMismatches,
  };
}

function buildIssues(params: {
  guardrails: GovernanceGuardrail[];
  hotspots: GovernanceHotspot[];
  largeFileCount: number;
  domains: GovernanceDomainRecord[];
  capabilities: GovernanceCapabilityRecord[];
  coverage: DomainCoverageState;
  capabilityAlignment: CapabilityAlignmentState;
}): GovernanceIssue[] {
  const issues: GovernanceIssue[] = [];

  for (const guardrail of params.guardrails) {
    const issue = createGuardrailIssue(guardrail);
    if (issue) {
      issues.push(issue);
    }
  }

  if (params.largeFileCount > 0 && params.hotspots.length > 0) {
    const hottest = params.hotspots[0];
    issues.push({
      id: "large-file-drift",
      severity: params.largeFileCount > 20 ? "high" : "medium",
      title: "Large-file drift is active",
      detail: `${params.largeFileCount} file(s) are above the configured line budget. The largest visible hotspot is ${hottest.path} at ${hottest.lines} lines.`,
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
      detail: `${unownedDomains.length} validated domain(s) in governance/domain-map.json do not declare owners.`,
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
      detail: `${unownedCapabilities.length} capability entr${unownedCapabilities.length === 1 ? "y" : "ies"} have no owners yet.`,
      path: "governance/capabilities",
      action:
        "Attach capability ownership before using the registry as a reviewer source of truth.",
    });
  }

  if (params.coverage.uncoveredFiles.length > 0) {
    issues.push({
      id: "uncovered-code-paths",
      severity: "medium",
      title: "Code paths are not fully covered by the domain map",
      detail: `${params.coverage.uncoveredFiles.length} analyzed file(s) do not match any declared domain. First gap: ${params.coverage.uncoveredFiles[0]}.`,
      path: "governance/domain-map.json",
      action:
        "Extend the domain map until every analyzed code path lands inside an explicit boundary.",
    });
  }

  if (params.coverage.overlappingFiles.length > 0) {
    const firstOverlap = params.coverage.overlappingFiles[0];
    issues.push({
      id: "overlapping-domain-paths",
      severity: "medium",
      title: "Domain paths overlap",
      detail: `${params.coverage.overlappingFiles.length} analyzed file(s) match multiple domains. First overlap: ${firstOverlap.path} (${firstOverlap.domains.join(", ")}).`,
      path: "governance/domain-map.json",
      action: "Tighten domain path seams so a code file belongs to exactly one primary domain.",
    });
  }

  if (params.coverage.missingCodeownersPaths.length > 0) {
    const firstMissing = params.coverage.missingCodeownersPaths[0];
    issues.push({
      id: "incomplete-codeowners-coverage",
      severity: "medium",
      title: "CODEOWNERS does not cover every governance path",
      detail: `${params.coverage.missingCodeownersPaths.length} governance path entr${params.coverage.missingCodeownersPaths.length === 1 ? "y is" : "ies are"} missing an explicit CODEOWNERS rule. First gap: ${firstMissing.path}.`,
      path: ".github/CODEOWNERS",
      action: "Add explicit CODEOWNERS entries for each governance domain path.",
    });
  }

  if (params.capabilityAlignment.missingPathCapabilities.length > 0) {
    const firstCapability = params.capabilityAlignment.missingPathCapabilities[0];
    issues.push({
      id: "capabilities-without-paths",
      severity: "low",
      title: "Capability registry entries are missing paths",
      detail: `${params.capabilityAlignment.missingPathCapabilities.length} capability entr${params.capabilityAlignment.missingPathCapabilities.length === 1 ? "y" : "ies"} do not declare any paths. First gap: ${firstCapability.id}.`,
      path: "governance/capabilities",
      action: "Add paths to every capability so the dashboard can align them to domain boundaries.",
    });
  }

  if (params.capabilityAlignment.unmappedPaths.length > 0) {
    const firstGap = params.capabilityAlignment.unmappedPaths[0];
    issues.push({
      id: "capability-paths-outside-domain-map",
      severity: "medium",
      title: "Capability paths escape the domain map",
      detail: `${params.capabilityAlignment.unmappedPaths.length} capability path entr${params.capabilityAlignment.unmappedPaths.length === 1 ? "y" : "ies"} do not land in any domain. First gap: ${firstGap.path} from ${firstGap.capability.id}.`,
      path: "governance/capabilities",
      action: "Either map these capability paths into an existing domain or add a new boundary.",
    });
  }

  if (params.capabilityAlignment.ownerMismatches.length > 0) {
    const firstMismatch = params.capabilityAlignment.ownerMismatches[0];
    issues.push({
      id: "capability-domain-owner-mismatch",
      severity: "medium",
      title: "Capability ownership diverges from domain ownership",
      detail: `${params.capabilityAlignment.ownerMismatches.length} capability entr${params.capabilityAlignment.ownerMismatches.length === 1 ? "y spans" : "ies span"} domain paths owned by different teams. First mismatch: ${firstMismatch.capability.id} vs ${firstMismatch.domains.map((domain) => domain.id).join(", ")}.`,
      path: "governance/capabilities",
      action: "Either align owners or split cross-domain capabilities into clearer seams.",
    });
  }

  const severityWeight = {
    high: 0,
    medium: 1,
    low: 2,
  } satisfies Record<GovernanceIssue["severity"], number>;

  return issues.toSorted(
    (left, right) => severityWeight[left.severity] - severityWeight[right.severity],
  );
}

function summarizeDomains(params: {
  domains: GovernanceDomainRecord[];
  coverage: DomainCoverageState;
}): GovernanceDomainSummary[] {
  return params.domains.map((domain) => ({
    id: domain.id,
    label: domain.label,
    description: domain.description,
    maturity: domain.maturity,
    owners: domain.owners ?? [],
    paths: domain.paths,
    fileCount: params.coverage.fileCountById.get(domain.id) ?? 0,
    largeFileCount: params.coverage.largeFileCountById.get(domain.id) ?? 0,
    issueCount: params.coverage.issueCountById.get(domain.id) ?? 0,
  }));
}

export async function computeGovernanceRepoFingerprint(params: {
  repoRoot: string;
  config: GovernancePluginConfig;
}): Promise<RepoFingerprint | null> {
  try {
    const gitState = runGit(params.repoRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignored=no",
      "--branch",
    ]);
    const hash = createHash("sha1").update(gitState).digest("hex");
    return {
      value: `git:${hash}`,
      mode: "git",
      inputCount: gitState.trim() ? gitState.trim().split("\n").length : 0,
    };
  } catch {
    // Fall through to filesystem fingerprinting.
  }

  const repoFiles = await listRepoFiles(params.repoRoot, { preferGit: false });
  const relevantFiles = repoFiles.filter((file) =>
    shouldFingerprintPath(file, params.config.codePaths),
  );
  const stats = await mapWithConcurrency(relevantFiles, 48, async (relativePath) => {
    try {
      const absolutePath = path.join(params.repoRoot, relativePath);
      const stat = await fs.stat(absolutePath);
      return `${relativePath}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return `${relativePath}:missing`;
    }
  });
  const hash = createHash("sha1").update(stats.sort().join("\n")).digest("hex");
  return {
    value: `filesystem:${hash}`,
    mode: "filesystem",
    inputCount: relevantFiles.length,
  };
}

export async function scanGovernanceSnapshot(params: {
  repoRoot: string;
  config: GovernancePluginConfig;
  log?: Logger;
}): Promise<GovernanceSnapshot> {
  const startedAt = Date.now();
  const repoFiles = await listRepoFiles(params.repoRoot);
  const docsPages = repoFiles.filter((file) => DOC_PAGE_RE.test(file)).length;
  const adrState = summarizeAdrRegistryState(repoFiles);
  const capabilityFiles = repoFiles.filter((file) => CAPABILITY_RE.test(file));
  const capabilityState = await summarizeCapabilityRegistryState(params.repoRoot, capabilityFiles);
  const extensionDirs = await listDirNames(path.join(params.repoRoot, "extensions"));
  const domainMapFile = await readJsonFile<GovernanceDomainMapFile>(
    path.join(params.repoRoot, "governance", "domain-map.json"),
  );
  const domainMapState = summarizeDomainMapState(domainMapFile);

  const analyzedFiles = repoFiles.filter((file) =>
    shouldAnalyzeFile(file, params.config.codePaths),
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

  const codeownersPatterns = await readCodeownersPatterns(params.repoRoot, repoFiles);
  const coverage = analyzeDomainCoverage({
    repoFiles,
    analyzedFiles,
    largeFiles: hotspotSummary.largeFiles,
    domains: domainMapState.domains,
    codeownersPatterns,
  });
  const capabilityAlignment = analyzeCapabilityAlignment({
    capabilities: capabilityState.capabilities,
    domains: domainMapState.domains,
    issueCountByDomainId: coverage.issueCountById,
  });
  const guardrails = summarizeGuardrails({
    repoFiles,
    adrState,
    domainMapState,
    capabilityState,
  });
  const issues = buildIssues({
    guardrails,
    hotspots: hotspotSummary.hotspots,
    largeFileCount: hotspotSummary.totalLargeFileCount,
    domains: domainMapState.domains,
    capabilities: capabilityState.capabilities,
    coverage,
    capabilityAlignment,
  });

  const unownedDomainCount = domainMapState.domains.filter(
    (entry) => !entry.owners || entry.owners.length === 0,
  ).length;
  const unownedCapabilityCount = capabilityState.capabilities.filter(
    (entry) => !entry.owners || entry.owners.length === 0,
  ).length;
  const score = calculateScore({
    guardrails,
    largeFileCount: hotspotSummary.totalLargeFileCount,
    unownedDomainCount,
    unownedCapabilityCount,
    uncoveredFileCount: coverage.uncoveredFiles.length,
    overlappingDomainCount: coverage.overlappingFiles.length,
    capabilityMismatchCount:
      capabilityAlignment.missingPathCapabilities.length +
      capabilityAlignment.unmappedPaths.length +
      capabilityAlignment.ownerMismatches.length,
  });

  return {
    generatedAt: new Date().toISOString(),
    repoRoot: params.repoRoot,
    summary: {
      totalFiles: repoFiles.length,
      tsFiles: repoFiles.filter((file) => /\.(?:ts|tsx)$/i.test(file)).length,
      extensions: extensionDirs.length,
      docsPages,
      adrCount: adrState.files.length,
      capabilityCount: capabilityState.capabilities.length,
      domainCount: domainMapState.domains.length,
      largeFileCount: hotspotSummary.totalLargeFileCount,
      maxFileLines: hotspotSummary.maxFileLines,
      analyzedFileCount: analyzedFiles.length,
      scanDurationMs: Date.now() - startedAt,
      score,
    },
    cards: buildCards({
      score,
      extensionCount: extensionDirs.length,
      capabilityCount: capabilityState.capabilities.length,
      domainCount: domainMapState.domains.length,
      adrCount: adrState.files.length,
      largeFileCount: hotspotSummary.totalLargeFileCount,
    }),
    guardrails,
    issues,
    hotspots: hotspotSummary.hotspots,
    domains: summarizeDomains({ domains: domainMapState.domains, coverage }),
    artifacts: buildArtifacts({
      repoFiles,
      adrState,
      domainMapState,
      capabilityState,
    }),
  };
}
