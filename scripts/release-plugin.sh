#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
README_OUT="$DIST_DIR/release.README.md"
PATCH_PATH="$ROOT_DIR/integrations/openclaw-core/openclaw-governance-dashboard.patch"
PACKAGE_VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
REPO="${GITHUB_REPOSITORY:-mbdtf202-cyber/openclaw-governance-dashboard}"
TAG="${GITHUB_REF_NAME:-v$PACKAGE_VERSION}"

mkdir -p "$DIST_DIR"

PACK_JSON="$(npm pack "$ROOT_DIR" --pack-destination "$DIST_DIR" --json)"
ARCHIVE_NAME="$(node -e 'const parsed = JSON.parse(process.argv[1]); process.stdout.write(parsed[0].filename);' "$PACK_JSON")"
ARCHIVE_PATH="$DIST_DIR/$ARCHIVE_NAME"
SHA_OUT="$DIST_DIR/$ARCHIVE_NAME.sha256"

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
else
  SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
fi
printf '%s  %s\n' "$SHA256" "$ARCHIVE_NAME" > "$SHA_OUT"

ARCHIVE_URL="https://github.com/$REPO/releases/download/$TAG/$ARCHIVE_NAME"
PATCH_URL="https://github.com/$REPO/releases/download/$TAG/$(basename "$PATCH_PATH")"

cat > "$README_OUT" <<EOF
# OpenClaw Governance Dashboard

Install the plugin archive:

\`\`\`bash
openclaw plugins install ./$ARCHIVE_NAME
\`\`\`

Apply the OpenClaw core integration patch if needed:

\`\`\`bash
git apply ./$(basename "$PATCH_PATH")
\`\`\`

Plugin URL:

$ARCHIVE_URL

Core patch URL:

$PATCH_URL

SHA256:

\`\`\`
$SHA256
\`\`\`
EOF

echo "Built:"
echo "  $ARCHIVE_PATH"
echo "  $SHA_OUT"
echo "  $README_OUT"
echo "  $PATCH_PATH"
