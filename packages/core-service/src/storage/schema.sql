-- Codebase Memory Sync — PostgreSQL schema
-- Apply via src/storage/postgres.ts on startup (idempotent)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── repos ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org             TEXT NOT NULL,
  name            TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  primary_lang    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org, name)
);

-- ── indexes ──────────────────────────────────────────────────────────────────
-- One row per (repo × commit × tool). CI wins over client.
CREATE TABLE IF NOT EXISTS indexes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha    TEXT NOT NULL,
  branch        TEXT,
  uploader      TEXT NOT NULL CHECK (uploader IN ('ci', 'client')),
  tool          TEXT NOT NULL,
  tool_version  TEXT,
  blob_key      TEXT,        -- MinIO object key, null until upload complete
  blob_sha256   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'ready', 'failed')),
  error_msg     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (repo_id, commit_sha, tool)
);

CREATE INDEX IF NOT EXISTS idx_indexes_repo_status ON indexes (repo_id, status);

-- ── symbols ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS symbols (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  index_id      UUID NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  repo_id       UUID NOT NULL,
  commit_sha    TEXT NOT NULL,
  scip_symbol   TEXT NOT NULL,   -- canonical SCIP symbol string
  display_name  TEXT,
  kind          TEXT,            -- e.g. 'class', 'method', 'field'
  language      TEXT,
  file_path     TEXT NOT NULL,
  start_line    INT,
  start_col     INT,
  end_line      INT,
  end_col       INT,
  signature     TEXT,
  doc           TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_index_id    ON symbols (index_id);
CREATE INDEX IF NOT EXISTS idx_symbols_repo_commit ON symbols (repo_id, commit_sha);
CREATE INDEX IF NOT EXISTS idx_symbols_scip        ON symbols (scip_symbol);
CREATE INDEX IF NOT EXISTS idx_symbols_display_gin ON symbols USING GIN (to_tsvector('simple', COALESCE(display_name, '')));

-- ── occurrences ──────────────────────────────────────────────────────────────
-- SCIP SymbolRole bitmask: Definition=1, Import=2, WriteAccess=4, ReadAccess=8, etc.
CREATE TABLE IF NOT EXISTS occurrences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  index_id    UUID NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  repo_id     UUID NOT NULL,
  commit_sha  TEXT NOT NULL,
  scip_symbol TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  start_line  INT,
  start_col   INT,
  end_line    INT,
  end_col     INT,
  role        INT NOT NULL DEFAULT 0   -- SymbolRole bitmask
);

CREATE INDEX IF NOT EXISTS idx_occ_index_id    ON occurrences (index_id);
CREATE INDEX IF NOT EXISTS idx_occ_symbol      ON occurrences (scip_symbol);
CREATE INDEX IF NOT EXISTS idx_occ_repo_commit ON occurrences (repo_id, commit_sha);

-- ── repo_head ────────────────────────────────────────────────────────────────
-- Tracks the latest indexed commit per (repo × branch)
CREATE TABLE IF NOT EXISTS repo_head (
  repo_id     UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch      TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  index_id    UUID REFERENCES indexes(id) ON DELETE SET NULL,
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (repo_id, branch)
);

-- ── upload_receipts ──────────────────────────────────────────────────────────
-- Idempotency: prevents duplicate processing on retry
CREATE TABLE IF NOT EXISTS upload_receipts (
  idempotency_key TEXT PRIMARY KEY,
  index_id        UUID NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── audit_log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  repo_id   UUID,
  index_id  UUID,
  detail    JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_ts      ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_repo_id ON audit_log (repo_id);

-- ── symbol_relationships ─────────────────────────────────────────────────────
-- Extracted from SCIP SymbolInformation.relationships[].
-- Edge direction: from_symbol (declarer) → to_symbol (target).
-- e.g. "class FooImpl implements IFoo":
--   from_symbol = 'scip-java...FooImpl#', to_symbol = 'scip-java...IFoo#',
--   is_implementation = true
CREATE TABLE IF NOT EXISTS symbol_relationships (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  index_id            UUID NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  repo_id             UUID NOT NULL,
  commit_sha          TEXT NOT NULL,
  from_symbol         TEXT NOT NULL,
  to_symbol           TEXT NOT NULL,
  is_reference        BOOLEAN NOT NULL DEFAULT false,
  is_implementation   BOOLEAN NOT NULL DEFAULT false,
  is_type_definition  BOOLEAN NOT NULL DEFAULT false,
  is_definition       BOOLEAN NOT NULL DEFAULT false
);

-- find_implementors: WHERE to_symbol = X AND is_implementation = true
CREATE INDEX IF NOT EXISTS idx_symrel_to_impl
  ON symbol_relationships (to_symbol, is_implementation);

-- get_dependencies: WHERE from_symbol = X
CREATE INDEX IF NOT EXISTS idx_symrel_from
  ON symbol_relationships (from_symbol);

-- get_impact_analysis seed: WHERE to_symbol = X
CREATE INDEX IF NOT EXISTS idx_symrel_to
  ON symbol_relationships (to_symbol);

-- repo-scoped queries
CREATE INDEX IF NOT EXISTS idx_symrel_repo
  ON symbol_relationships (repo_id, commit_sha);
