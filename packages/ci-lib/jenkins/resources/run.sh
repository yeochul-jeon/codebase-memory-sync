#!/usr/bin/env bash
# CI indexer entrypoint — runs inside the scip-indexer Docker container.
# Mounts: /work = project root
# Output: /work/index.scip

set -euo pipefail

WORK_DIR="${WORK_DIR:-/work}"
OUTPUT="${WORK_DIR}/index.scip"

cd "$WORK_DIR"

echo "[cms-ci] Detecting project type..."

if [ -f "pom.xml" ]; then
    echo "[cms-ci] Detected Maven project — running scip-java"
    scip-java index --build-tool maven --output "$OUTPUT"

elif [ -f "build.gradle" ] || [ -f "build.gradle.kts" ]; then
    echo "[cms-ci] Detected Gradle project — running scip-java"
    scip-java index --build-tool gradle --output "$OUTPUT"

elif [ -f "package.json" ] && ([ -f "tsconfig.json" ] || grep -q '"typescript"' package.json 2>/dev/null); then
    echo "[cms-ci] Detected TypeScript project — running scip-typescript"
    npm ci --prefer-offline 2>/dev/null || true
    scip-typescript index --output "$OUTPUT"

else
    echo "[cms-ci] Fallback: running scip-ctags (symbol-only)"
    scip-ctags --output "$OUTPUT" --from-directory "$WORK_DIR"
fi

echo "[cms-ci] Index generated: $(du -sh "$OUTPUT" | cut -f1)"
