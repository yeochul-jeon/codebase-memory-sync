#!/usr/bin/env bash
# Generates a minimal test SCIP fixture binary.
# Output: /tmp/cms-test-fixture.scip  (or $1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT="${1:-/tmp/cms-test-fixture.scip}"

cd "$ROOT_DIR"

TSX="${ROOT_DIR}/packages/scip-processor/node_modules/.bin/tsx"
"$TSX" scripts/make-fixture.ts "$OUTPUT"
