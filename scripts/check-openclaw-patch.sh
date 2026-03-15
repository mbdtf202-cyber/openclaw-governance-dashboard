#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATCH_PATH="$ROOT_DIR/integrations/openclaw-core/openclaw-governance-dashboard.patch"
TARGET_REPO="${1:-${OPENCLAW_REPO_DIR:-}}"
TMP_DIR=""

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if [[ -z "$TARGET_REPO" ]]; then
  TMP_DIR="$(mktemp -d)"
  TARGET_REPO="$TMP_DIR/openclaw"
  git clone --depth 1 https://github.com/openclaw/openclaw.git "$TARGET_REPO" >/dev/null 2>&1
fi

git -C "$TARGET_REPO" apply --check "$PATCH_PATH"
echo "Patch applies cleanly to: $TARGET_REPO"
