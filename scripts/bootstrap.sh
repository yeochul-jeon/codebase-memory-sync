#!/usr/bin/env bash
# Bootstrap local development environment.
# Starts Postgres + MinIO, waits for health, then installs Node deps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# ── .env ──────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "  ⚠  Edit .env to set secure passwords before production use."
fi

# Load env (without export to avoid polluting shell)
set -a; source .env; set +a

# ── Docker Compose ────────────────────────────────────────────────────────────
echo "Starting infrastructure services..."
docker compose up -d postgres minio

echo "Waiting for Postgres to be healthy..."
until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-cms}" -d "${POSTGRES_DB:-cms}" 2>/dev/null; do
    printf '.'
    sleep 1
done
echo " ✓ Postgres ready"

echo "Waiting for MinIO to be healthy..."
until docker compose exec -T minio mc ready local 2>/dev/null; do
    printf '.'
    sleep 1
done
echo " ✓ MinIO ready"

# Run minio-init to create bucket
docker compose up -d minio-init
echo "MinIO bucket initialized."

# ── Node dependencies ─────────────────────────────────────────────────────────
echo "Installing Node dependencies..."
corepack enable pnpm 2>/dev/null || npm install -g pnpm
pnpm install

echo ""
echo "✅ Bootstrap complete."
echo ""
echo "Start core-service:    pnpm --filter @cms/core-service dev"
echo "Start scip-processor:  pnpm --filter @cms/scip-processor dev"
echo "Run E2E test:          ./scripts/e2e.sh"
