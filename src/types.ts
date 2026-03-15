export type GovernancePluginConfig = {
  enabled: boolean;
  repoRoot?: string;
  refreshIntervalMs: number;
  largeFileLineThreshold: number;
  hotspotLimit: number;
  codePaths: string[];
};

export type GovernanceGuardrailStatus = "ok" | "warn" | "missing" | "invalid";

export type GovernanceArtifactStatus = "ok" | "invalid";

export type GovernanceSummaryCard = {
  id: string;
  label: string;
  value: string;
  helper?: string;
  tone?: "neutral" | "ok" | "warn" | "alert";
};

export type GovernanceGuardrail = {
  id: string;
  label: string;
  status: GovernanceGuardrailStatus;
  detail: string;
};

export type GovernanceIssue = {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  path?: string;
  action?: string;
};

export type GovernanceHotspot = {
  path: string;
  lines: number;
  category?: string;
};

export type GovernanceDomainRecord = {
  id: string;
  label: string;
  description?: string;
  maturity?: "experimental" | "supported" | "stable" | "deprecated";
  owners?: string[];
  paths: string[];
};

export type GovernanceCapabilityRecord = {
  id: string;
  label: string;
  description?: string;
  owners?: string[];
  paths?: string[];
  maturity?: "experimental" | "supported" | "stable" | "deprecated";
};

export type GovernanceDomainSummary = {
  id: string;
  label: string;
  description?: string;
  maturity?: string;
  owners?: string[];
  paths?: string[];
  fileCount?: number;
  largeFileCount?: number;
  issueCount?: number;
};

export type GovernanceArtifact = {
  id: string;
  label: string;
  path: string;
  kind: "domain-map" | "capability" | "adr" | "script";
  status?: GovernanceArtifactStatus;
  detail?: string;
};

export type GovernanceSnapshot = {
  generatedAt: string;
  repoRoot: string;
  summary: {
    totalFiles: number;
    tsFiles: number;
    extensions: number;
    docsPages: number;
    adrCount: number;
    capabilityCount: number;
    domainCount: number;
    largeFileCount: number;
    maxFileLines: number;
    analyzedFileCount: number;
    scanDurationMs: number;
    score: number;
  };
  cards: GovernanceSummaryCard[];
  guardrails: GovernanceGuardrail[];
  issues: GovernanceIssue[];
  hotspots: GovernanceHotspot[];
  domains: GovernanceDomainSummary[];
  artifacts: GovernanceArtifact[];
};

export type GovernanceSnapshotResult = {
  available: boolean;
  pluginId: string;
  pluginVersion?: string;
  repoRoot?: string | null;
  refreshedAt: string;
  lastSuccessfulScanAt?: string | null;
  stale?: boolean;
  config: {
    refreshIntervalMs: number;
    largeFileLineThreshold: number;
    hotspotLimit: number;
  };
  message?: string;
  snapshot?: GovernanceSnapshot | null;
};
