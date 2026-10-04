-- CryptoTrace AI schema. Postgres 14+. Idempotent: safe to re-run.

-- Notes on portability:
--  * gen_random_uuid() is core Postgres 13+, so no extension is required. (PGlite
--    ships without pgcrypto, and requiring it would force a real server for local work.)
--  * Timestamps use the spelled-out TIMESTAMP WITH TIME ZONE rather than the
--    timestamptz alias. PGlite's parser rejects the all-caps alias, and the long
--    form is standard SQL that both engines accept.

-- ---------------------------------------------------------------- enum types
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'investigator', 'analyst', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE case_status AS ENUM ('Open', 'In Progress', 'Under Review', 'Escalated', 'Closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_level AS ENUM ('Critical', 'High', 'Medium', 'Low', 'Unrated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE entity_kind AS ENUM ('wallet', 'transaction', 'contract', 'exchange', 'mixer', 'bridge', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_severity AS ENUM ('critical', 'high', 'medium', 'low', 'info');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_state AS ENUM ('open', 'acknowledged', 'resolved', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'viewer',
  agency          TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at  TIMESTAMP WITH TIME ZONE,
  user_agent  TEXT,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON refresh_tokens(expires_at);

-- Why a token was revoked. Reuse detection treats a replayed 'rotated' token as
-- evidence of theft, while a replayed 'logout' or 'password_change' token is
-- just another tab holding a session the user has already ended. Added after the
-- table shipped, hence the ALTER rather than a column in the CREATE.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

-- Login throttling. This used to be a per-process Map, which meant a restart
-- wiped every counter and N instances each enforced N separate budgets against
-- the same shared database. A row per (email, ip) gives one budget that survives
-- restarts and is consistent across instances.
CREATE TABLE IF NOT EXISTS login_attempts (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 1,
  reset_at    TIMESTAMP WITH TIME ZONE NOT NULL,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_reset_idx ON login_attempts(reset_at);

-- Case references are CT-<year>-<n>. The counter is a sequence rather than
-- MAX(...)+1 so concurrent case creation cannot collide on the unique index.
CREATE SEQUENCE IF NOT EXISTS case_ref_seq START 1;

-- ------------------------------------------------------------------- cases
CREATE TABLE IF NOT EXISTS cases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref      TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  description   TEXT,
  chain         TEXT NOT NULL,
  status        case_status NOT NULL DEFAULT 'Open',
  priority      risk_level NOT NULL DEFAULT 'Unrated',
  lead_investigator_id UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  closed_at     TIMESTAMP WITH TIME ZONE,
  -- Closure is a recorded decision, not just a status: who ended the case and
  -- the rationale they gave are held on the row so the record survives even if
  -- the pinned note is later edited or the case is reopened.
  closed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  closure_note  TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cases_status_idx ON cases(status);
CREATE INDEX IF NOT EXISTS cases_updated_idx ON cases(updated_at DESC);

-- Added after the initial release; kept idempotent so an existing embedded
-- database picks them up on the next migrate.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS closure_note TEXT;

-- The seed identifier an investigation started from, and where the allegation
-- came from. `seed_kind` records which of the two shapes was supplied so a
-- reader can tell a transaction seed from an address seed without inferring it
-- from the value's format -- a BTC address and a BTC tx hash are both hex-ish
-- strings, and guessing wrong silently misrepresents the origin of a case.
--
-- This is separate from case_entities: a transaction seed's hash has no entity
-- row (only the addresses it pays get one), so the hash would otherwise be
-- lost the moment the case was created.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS seed_kind TEXT CHECK (seed_kind IN ('address','tx'));
ALTER TABLE cases ADD COLUMN IF NOT EXISTS seed_value TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS referral_source TEXT;

CREATE TABLE IF NOT EXISTS case_assignees (
  case_id  UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, user_id)
);

-- ------------------------------------------------- entities and blockchain
CREATE TABLE IF NOT EXISTS entities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain         TEXT NOT NULL,
  address       TEXT NOT NULL,
  kind          entity_kind NOT NULL DEFAULT 'unknown',
  label         TEXT,
  risk_score    INTEGER NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  risk_level    risk_level NOT NULL DEFAULT 'Unrated',
  risk_factors  JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_seen    TIMESTAMP WITH TIME ZONE,
  last_seen     TIMESTAMP WITH TIME ZONE,
  tx_count      INTEGER NOT NULL DEFAULT 0,
  volume_native NUMERIC(38, 8),
  volume_usd    NUMERIC(24, 2),
  raw           JSONB,
  status        TEXT CHECK (status IN ('known','verified','unknown','unresolved','partial','truncated','unsupported','unavailable')),
  status_reason TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (chain, address)
);
CREATE INDEX IF NOT EXISTS entities_risk_idx ON entities(risk_score DESC);
CREATE INDEX IF NOT EXISTS entities_kind_idx ON entities(kind);

-- Add status and status_reason columns if they don't exist (for existing databases)
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status TEXT CHECK (status IN ('known','verified','unknown','unresolved','partial','truncated','unsupported','unavailable'));
ALTER TABLE entities ADD COLUMN IF NOT EXISTS status_reason TEXT;

CREATE TABLE IF NOT EXISTS transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain         TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  block_height  BIGINT,
  timestamp     TIMESTAMP WITH TIME ZONE,
  from_address  TEXT,
  to_address    TEXT,
  value_native  NUMERIC(38, 18),
  value_usd     NUMERIC(24, 2),
  status        TEXT,
  fee_native    NUMERIC(38, 18),
  raw           JSONB,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash)
);
CREATE INDEX IF NOT EXISTS transactions_from_idx ON transactions(chain, from_address);
CREATE INDEX IF NOT EXISTS transactions_to_idx ON transactions(chain, to_address);
CREATE INDEX IF NOT EXISTS transactions_time_idx ON transactions(timestamp DESC);

-- Normalized multi-leg movements (UTXO in/out, ERC-20 Transfer logs). Written by
-- the indexer; the chain providers also produce this shape in-process, so both
-- paths agree on field names. Null/[] means "not indexed", not "no transfers".
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfers JSONB;

CREATE TABLE IF NOT EXISTS case_entities (
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  entity_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  hop_count   INTEGER NOT NULL DEFAULT 0,
  amount_usd  NUMERIC(24, 2),
  note        TEXT,
  added_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, entity_id)
);
CREATE INDEX IF NOT EXISTS case_entities_case_idx ON case_entities(case_id);

CREATE TABLE IF NOT EXISTS case_transactions (
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  added_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, transaction_id)
);

-- ------------------------------------------------------- tracing / analytics
CREATE TABLE IF NOT EXISTS traces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID REFERENCES cases(id) ON DELETE CASCADE,
  chain         TEXT NOT NULL,
  root_address  TEXT NOT NULL,
  max_hops      INTEGER NOT NULL,
  direction     TEXT NOT NULL DEFAULT 'forward',
  node_count    INTEGER NOT NULL DEFAULT 0,
  edge_count    INTEGER NOT NULL DEFAULT 0,
  total_usd     NUMERIC(24, 2),
  risk_score    INTEGER NOT NULL DEFAULT 0,
  risk_level    risk_level NOT NULL DEFAULT 'Unrated',
  graph         JSONB NOT NULL,
  truncated_reasons TEXT[],
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS traces_case_idx ON traces(case_id, created_at DESC);

-- Add truncated_reasons column if it doesn't exist
ALTER TABLE traces ADD COLUMN IF NOT EXISTS truncated_reasons TEXT[];

-- ------------------------------------------------------------------ data lineage tracking
CREATE TABLE IF NOT EXISTS provider_responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain           TEXT NOT NULL,
  request_type    TEXT NOT NULL,
  request_params  JSONB NOT NULL,
  response_data   JSONB,
  response_hash   TEXT NOT NULL,
  provider        TEXT NOT NULL,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  success         BOOLEAN NOT NULL DEFAULT FALSE,
  error           TEXT,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_responses_chain_idx ON provider_responses(chain, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_responses_hash_idx ON provider_responses(response_hash);

CREATE TABLE IF NOT EXISTS normalized_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_response_id    UUID NOT NULL REFERENCES provider_responses(id) ON DELETE CASCADE,
  event_type              TEXT NOT NULL,
  chain                   TEXT NOT NULL,
  normalized_data         JSONB NOT NULL,
  raw_response_ref        TEXT,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS normalized_events_provider_idx ON normalized_events(provider_response_id);

-- Graph nodes: one row per address in a trace. Enables SQL filtering by
-- address, chain, asset, hop distance, and risk level. Nodes were previously
-- only inside the traces.graph JSONB blob, making ad-hoc queries impossible.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id                UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  case_id                 UUID REFERENCES cases(id) ON DELETE CASCADE,
  address                 TEXT NOT NULL,
  chain                   TEXT NOT NULL,
  kind                    TEXT NOT NULL DEFAULT 'address',
  label                   TEXT,
  risk_score              INTEGER NOT NULL DEFAULT 0,
  risk_level              TEXT NOT NULL DEFAULT 'Unrated',
  first_seen              TIMESTAMP WITH TIME ZONE,
  last_seen               TIMESTAMP WITH TIME ZONE,
  tx_count                INTEGER NOT NULL DEFAULT 0,
  in_volume_usd           NUMERIC(24, 2),
  out_volume_usd          NUMERIC(24, 2),
  hop_distance            INTEGER NOT NULL DEFAULT 0,
  asset                   TEXT NOT NULL DEFAULT 'native',
  status                  TEXT NOT NULL DEFAULT 'known',
  status_reason           TEXT,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graph_nodes_trace_idx ON graph_nodes(trace_id);
CREATE INDEX IF NOT EXISTS graph_nodes_case_idx ON graph_nodes(case_id);
CREATE INDEX IF NOT EXISTS graph_nodes_address_idx ON graph_nodes(address, chain);
CREATE INDEX IF NOT EXISTS graph_nodes_hop_idx ON graph_nodes(hop_distance);

CREATE TABLE IF NOT EXISTS graph_edges (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id                UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  case_id                 UUID REFERENCES cases(id) ON DELETE CASCADE,
  source                  TEXT NOT NULL,
  target                  TEXT NOT NULL,
  tx_hash                 TEXT NOT NULL,
  timestamp               TIMESTAMP WITH TIME ZONE,
  value_native            NUMERIC(38, 18) NOT NULL,
  value_usd               NUMERIC(24, 2),
  asset                   TEXT NOT NULL DEFAULT 'native',
  asset_identifier        TEXT,
  decimals                INTEGER NOT NULL DEFAULT 18,
  normalized_event_id     UUID REFERENCES normalized_events(id) ON DELETE SET NULL,
  provider_response_id    UUID REFERENCES provider_responses(id) ON DELETE SET NULL,
  /*
   * Evidence layer. Persisted alongside the observation because a stored trace
   * has to be auditable on its own: without these, re-reading a trace from the
   * database yields a graph whose edges look equally certain while the JSON
   * snapshot they were built from says otherwise.
   */
  observed_amount         NUMERIC(38, 18),
  traced_amount           NUMERIC(38, 18),
  relationship            TEXT NOT NULL DEFAULT 'direct_transfer',
  evidence_status         TEXT NOT NULL DEFAULT 'derived',
  trace_method            TEXT,
  confidence              NUMERIC(4, 3),
  evidence_source         TEXT NOT NULL DEFAULT 'stored',
  evidence_reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graph_edges_trace_idx ON graph_edges(trace_id);
CREATE INDEX IF NOT EXISTS graph_edges_case_idx ON graph_edges(case_id);
CREATE INDEX IF NOT EXISTS graph_edges_tx_idx ON graph_edges(tx_hash);
CREATE INDEX IF NOT EXISTS graph_edges_evidence_idx ON graph_edges(trace_id, evidence_status);

CREATE TABLE IF NOT EXISTS flow_analyses (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  graph_edge_id           UUID NOT NULL REFERENCES graph_edges(id) ON DELETE CASCADE,
  analysis_type           TEXT NOT NULL,
  input_total_native      NUMERIC(38, 18) NOT NULL,
  output_total_native     NUMERIC(38, 18) NOT NULL,
  input_total_usd         NUMERIC(24, 2),
  output_total_usd        NUMERIC(24, 2),
  discrepancy_native      NUMERIC(38, 18) NOT NULL,
  discrepancy_usd         NUMERIC(24, 2),
  status                  TEXT NOT NULL CHECK (status IN ('balanced','partial','data_limitation','unreconciled')),
  details                 JSONB,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_analyses_case_idx ON flow_analyses(case_id);
CREATE INDEX IF NOT EXISTS flow_analyses_edge_idx ON flow_analyses(graph_edge_id);

CREATE TABLE IF NOT EXISTS risk_alerts_lineage (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  flow_analysis_id        UUID REFERENCES flow_analyses(id) ON DELETE SET NULL,
  graph_edge_id           UUID REFERENCES graph_edges(id) ON DELETE SET NULL,
  entity_id               UUID REFERENCES entities(id) ON DELETE SET NULL,
  alert_type              TEXT NOT NULL CHECK (alert_type IN ('risk_signal','alert')),
  severity                TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  title                   TEXT NOT NULL,
  description             TEXT,
  evidence                JSONB,
  source_steps            UUID[] NOT NULL DEFAULT '{}',
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_alerts_lineage_case_idx ON risk_alerts_lineage(case_id);
CREATE INDEX IF NOT EXISTS risk_alerts_lineage_flow_idx ON risk_alerts_lineage(flow_analysis_id);
CREATE INDEX IF NOT EXISTS risk_alerts_lineage_edge_idx ON risk_alerts_lineage(graph_edge_id);

-- Cross-chain bridge events
CREATE TABLE IF NOT EXISTS bridge_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 UUID REFERENCES cases(id) ON DELETE CASCADE,
  trace_id                UUID REFERENCES traces(id) ON DELETE SET NULL,
  source_chain            TEXT NOT NULL,
  source_address          TEXT NOT NULL,
  source_tx_hash          TEXT NOT NULL,
  -- Destination is NULLABLE on purpose. Seeing a transfer into a known bridge
  -- contract proves a source-side leg only. The destination chain, address and
  -- tx hash are not observed until that chain is actually queried, so storing a
  -- value here would be a guess presented as evidence. Candidate routes live in
  -- `metadata.candidate_destination_chains` instead.
  destination_chain       TEXT,
  destination_address     TEXT,
  destination_tx_hash     TEXT,
  bridge_name             TEXT,
  bridge_contract         TEXT,
  asset                   TEXT NOT NULL,
  asset_identifier        TEXT,
  amount_native           NUMERIC(38, 18) NOT NULL,
  amount_usd              NUMERIC(24, 2),
  status                  TEXT NOT NULL DEFAULT 'detected'
                          CHECK (status IN ('detected','confirmed','pending','failed')),
  confidence              TEXT NOT NULL DEFAULT 'medium'
                          CHECK (confidence IN ('low','medium','high')),
  metadata                JSONB,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bridge_events_case_idx ON bridge_events(case_id);
CREATE INDEX IF NOT EXISTS bridge_events_source_idx ON bridge_events(source_chain, source_tx_hash);
-- Partial index: the destination lookups that matter are the confirmed ones.
-- A detected-but-unfollowed leg has NULL destination_chain and should not
-- appear in destination-side result sets.
CREATE INDEX IF NOT EXISTS bridge_events_dest_idx ON bridge_events(destination_chain, destination_tx_hash)
  WHERE destination_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS bridge_events_bridge_idx ON bridge_events(bridge_name);

-- Loosen the NOT NULLs on databases created before this change. DROP NOT NULL
-- is non-destructive, unlike dropping and re-adding the column.
ALTER TABLE bridge_events ALTER COLUMN destination_chain DROP NOT NULL;
ALTER TABLE bridge_events ALTER COLUMN destination_address DROP NOT NULL;
ALTER TABLE bridge_events ADD COLUMN IF NOT EXISTS candidate_destination_chains TEXT[];

CREATE TABLE IF NOT EXISTS report_findings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  report_id               UUID NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  risk_alert_id           UUID REFERENCES risk_alerts_lineage(id) ON DELETE SET NULL,
  flow_analysis_id        UUID REFERENCES flow_analyses(id) ON DELETE SET NULL,
  finding_type            TEXT NOT NULL,
  title                   TEXT NOT NULL,
  description             TEXT,
  source_steps            UUID[] NOT NULL DEFAULT '{}',
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_findings_case_idx ON report_findings(case_id);
CREATE INDEX IF NOT EXISTS report_findings_report_idx ON report_findings(report_id);
CREATE INDEX IF NOT EXISTS report_findings_alert_idx ON report_findings(risk_alert_id);

CREATE TABLE IF NOT EXISTS lineage_chains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id         UUID NOT NULL REFERENCES provider_responses(id) ON DELETE CASCADE,
  case_id         UUID REFERENCES cases(id) ON DELETE CASCADE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lineage_chains_root_idx ON lineage_chains(root_id);
CREATE INDEX IF NOT EXISTS lineage_chains_case_idx ON lineage_chains(case_id);

CREATE TABLE IF NOT EXISTS lineage_steps (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id                UUID NOT NULL REFERENCES lineage_chains(id) ON DELETE CASCADE,
  step                    INTEGER NOT NULL,
  stage                   TEXT NOT NULL CHECK (stage IN ('provider_response','raw_response_hash','normalized_event','graph_edge','flow_analysis','risk_alert','report_finding','audit_record')),
  entity_type             TEXT NOT NULL,
  entity_id               UUID NOT NULL,
  description             TEXT,
  previous_step_id        UUID REFERENCES lineage_steps(id) ON DELETE SET NULL,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lineage_steps_chain_idx ON lineage_steps(chain_id, step);
CREATE INDEX IF NOT EXISTS lineage_steps_entity_idx ON lineage_steps(entity_type, entity_id);

-- ------------------------------------------------------------------ evidence
CREATE TABLE IF NOT EXISTS evidence (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description    TEXT,
  chain         TEXT,
  address       TEXT,
  tx_hash       TEXT,
  content       JSONB,
  content_sha256 TEXT NOT NULL,
  collected_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  collected_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_case_idx ON evidence(case_id, collected_at DESC);

-- ------------------------------------------------------------------- alerts
CREATE TABLE IF NOT EXISTS alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID REFERENCES cases(id) ON DELETE CASCADE,
  entity_id     UUID REFERENCES entities(id) ON DELETE CASCADE,
  severity      alert_severity NOT NULL DEFAULT 'info',
  state         alert_state NOT NULL DEFAULT 'open',
  category      TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  dedupe_key    TEXT UNIQUE,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  resolved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS alerts_state_idx ON alerts(state, created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_severity_idx ON alerts(severity);

-- The entity score that triggered an alert. Previously this existed only as
-- prose interpolated into `detail`, which made it impossible to sort by, filter
-- on, chart, or export as a number. Backfilled from the stored entities where
-- an alert is still linked to one.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS risk_score INTEGER;
UPDATE alerts a
   SET risk_score = e.risk_score
  FROM entities e
 WHERE a.entity_id = e.id
   AND a.risk_score IS NULL;
CREATE INDEX IF NOT EXISTS alerts_risk_score_idx ON alerts(risk_score DESC NULLS LAST);

-- ------------------------------------------- labels (third-party attribution)
-- Separate from on-chain facts on purpose: a label is a sourced claim about an
-- address, and it carries its own provenance and challenge state.
CREATE TABLE IF NOT EXISTS labels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain           TEXT NOT NULL,
  address         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('exchange','mixer','bridge','sanctioned','darknet','service')),
  name            TEXT NOT NULL,
  source          TEXT NOT NULL,
  source_url      TEXT,
  confidence      TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  observed_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','challenged','retracted')),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  challenged_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  challenged_at   TIMESTAMP WITH TIME ZONE,
  challenge_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS labels_active_unique
  ON labels (chain, address, kind, source) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS labels_address_idx ON labels (chain, address);
CREATE INDEX IF NOT EXISTS labels_status_idx ON labels (status);

-- ---------------------------------------------------------------- audit log
-- Append-only. UPDATE/DELETE revoked at the application layer and by trigger.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  case_ref     TEXT,
  before       JSONB,
  after        JSONB,
  ip           TEXT,
  user_agent   TEXT,
  outcome      TEXT NOT NULL DEFAULT 'success'
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_case_idx ON audit_log(case_ref, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action, at DESC);

CREATE OR REPLACE FUNCTION audit_log_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_immutable();

-- ------------------------------------------------------- updated_at triggers
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cases_updated_at ON cases;
CREATE TRIGGER cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS entities_updated_at ON entities;
CREATE TRIGGER entities_updated_at BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS alerts_updated_at ON alerts;
CREATE TRIGGER alerts_updated_at BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------- automated pipeline events
-- Every event the AI/trace pipeline reports about a case, in order, whether or
-- not it moved the status. This is the record the Analysis view renders, so the
-- pipeline is a log rather than something inferred from `cases.status`: an
-- inferred pipeline cannot tell "the risk engine has not run yet" apart from
-- "the risk engine ran and found nothing".
--
-- `actor_id` is NULL for machine-driven events. It is a nullable foreign key
-- precisely so the pipeline can record its own work without impersonating a
-- user; the synthetic 'system' value that would be convenient here is not a
-- UUID and would fail the constraint.
CREATE TABLE IF NOT EXISTS case_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Both null for an event that did not move the case. Retained rather than
  -- derived so a reader can see the status the engine considered.
  from_status case_status,
  to_status   case_status,
  reason      TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_events_case_idx ON case_events(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS case_events_type_idx ON case_events(event_type, created_at DESC);

-- ------------------------------------------------------- investigation notes
CREATE TABLE IF NOT EXISTS case_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','hypothesis','finding','status')),
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_notes_case_idx ON case_notes(case_id, created_at DESC);

-- ------------------------------------------ risk rule weight configuration
CREATE TABLE IF NOT EXISTS risk_config (
  rule        TEXT PRIMARY KEY,
  weight      INTEGER NOT NULL CHECK (weight BETWEEN 0 AND 100),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ saved searches
CREATE TABLE IF NOT EXISTS saved_searches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_searches_owner_idx ON saved_searches(owner_id);

-- -------------------------------------------------- integration configuration
CREATE TABLE IF NOT EXISTS integration_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  chain         TEXT,
  base_url      TEXT,
  api_key_ref   TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 120,
  notes         TEXT,
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ------------------------------------------------ uploaded case documents
-- The file itself lives on disk under server/data/uploads; this row is the
-- record of it. `sha256` is over the raw bytes, computed before extraction, so
-- "this is the file we read" stays verifiable independently of anything the
-- extractor or the model produced from it.
CREATE TABLE IF NOT EXISTS documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  byte_size      BIGINT NOT NULL,
  sha256         TEXT NOT NULL,
  storage_path   TEXT NOT NULL,
  page_count              INTEGER,
  char_count              INTEGER,
  -- OCR metadata (NULL when OCR not used)
  ocr_used                BOOLEAN NOT NULL DEFAULT FALSE,
  ocr_language            TEXT,
  ocr_average_confidence  NUMERIC(5, 2),
  ocr_pages_processed     INTEGER,
  -- 'pending'   = stored, text not yet extracted
  -- 'extracted' = text available, not yet sent to the model
  -- 'analyzed'  = a proposal exists
  -- 'failed'    = extraction or analysis failed; `error` records why
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','extracted','analyzed','failed')),
  error          TEXT,
  extracted_text TEXT,
  uploaded_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  analyzed_at    TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS documents_case_idx ON documents(case_id, created_at DESC);
-- Re-uploading identical bytes to the same case is a no-op rather than a
-- second copy of the same evidence.
CREATE UNIQUE INDEX IF NOT EXISTS documents_sha_unique ON documents(case_id, sha256);

-- Add OCR columns for databases created before this change
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_used BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_language TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_average_confidence NUMERIC(5, 2);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_pages_processed INTEGER;

-- ------------------------------------------------------ AI case proposals
-- A model never writes to `cases`, `entities` or `traces`. It emits a proposal
-- here, a human approves the individual indicators, and `apply` performs the
-- writes. `proposal` keeps the exact model output so the reviewer reads what
-- the model actually said rather than a summary of it.
CREATE TABLE IF NOT EXISTS ai_proposals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  document_id    UUID REFERENCES documents(id) ON DELETE SET NULL,
  -- 'pending'  = awaiting review
  -- 'applying' = claimed by a reviewer inside the apply transaction. Never
  --              observed outside a transaction, but it must be a legal value
  --              so the claim can be expressed as a conditional UPDATE rather
  --              than a read-then-write race between two reviewers.
  -- 'applied'  = a human applied it
  -- 'rejected' = a human discarded it
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','applying','applied','rejected')),
  proposal       JSONB NOT NULL,
  model          TEXT NOT NULL,
  -- Identifies the prompt that produced this, so a change in extraction logic
  -- is visible in the register rather than silently redefining what an
  -- earlier approval meant.
  prompt_version TEXT NOT NULL,
  -- Which indicators the reviewer accepted, by index into the proposal's
  -- indicator list. Null until decided.
  accepted_indexes INTEGER[],
  applied_summary  JSONB,
  trace_id      UUID REFERENCES traces(id) ON DELETE SET NULL,
  evidence_id   UUID REFERENCES evidence(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  decided_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS ai_proposals_case_idx ON ai_proposals(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_proposals_status_idx ON ai_proposals(status);

-- Widen the status check for databases created before 'applying' existed.
-- CREATE TABLE IF NOT EXISTS does not touch an existing table, so the
-- constraint has to be replaced explicitly. Guarded on the constraint's
-- current definition so re-running this is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_proposals_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%applying%'
  ) THEN
    -- Only relax it; never tighten, or a row written by a newer build would
    -- block an older one from starting.
    ALTER TABLE ai_proposals DROP CONSTRAINT ai_proposals_status_check;
    ALTER TABLE ai_proposals
      ADD CONSTRAINT ai_proposals_status_check
      CHECK (status IN ('pending','applying','applied','rejected'));
  END IF;
END $$;

-- One pending proposal per document, so a double-click cannot create two
-- competing reviews of the same file.
CREATE UNIQUE INDEX IF NOT EXISTS ai_proposals_pending_unique
  ON ai_proposals (document_id) WHERE status = 'pending' AND document_id IS NOT NULL;

-- ------------------------------------------------------- trace plans
CREATE TABLE IF NOT EXISTS trace_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id    UUID NOT NULL REFERENCES ai_proposals(id) ON DELETE CASCADE,
  case_id        UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  -- 'pending'   = generated, awaiting review
  -- 'executing' = investigator approved, trace running
  -- 'executed'  = trace completed (success or partial)
  -- 'rejected'  = investigator discarded the plan
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','executing','executed','rejected')),
  plan           JSONB NOT NULL,
  execution_summary JSONB,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  executed_at    TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS trace_plans_case_idx ON trace_plans(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trace_plans_status_idx ON trace_plans(status);
CREATE INDEX IF NOT EXISTS trace_plans_proposal_idx ON trace_plans(proposal_id);

-- ------------------------------------------------- background job queue
-- Declared last on purpose: trace_jobs/auto_process_jobs reference documents,
-- and trace_snapshots references trace_jobs. Earlier in this file they sat
-- ahead of those tables, so their foreign keys resolved against relations that
-- did not exist yet and a fresh database could not migrate at all.
-- Trace jobs for long-running trace operations
CREATE TABLE IF NOT EXISTS trace_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID REFERENCES cases(id) ON DELETE CASCADE,
  trace_plan_id UUID REFERENCES trace_plans(id) ON DELETE SET NULL,
  chain         TEXT NOT NULL,
  root_address  TEXT NOT NULL,
  max_hops      INTEGER NOT NULL,
  direction     TEXT NOT NULL DEFAULT 'forward',
  max_nodes     INTEGER NOT NULL DEFAULT 120,
  max_edges     INTEGER NOT NULL DEFAULT 150,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','retry','partial','completed','failed','cancelled')),
  progress      JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_trace_id UUID REFERENCES traces(id) ON DELETE SET NULL,
  error         TEXT,
  started_at    TIMESTAMP WITH TIME ZONE,
  completed_at  TIMESTAMP WITH TIME ZONE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trace_jobs_case_idx ON trace_jobs(case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trace_jobs_status_idx ON trace_jobs(status);

-- The worker parks a failed job in 'retry' with a backoff until attempts
-- reaches max_retries. 'retry' was not in the original CHECK, so widen it for
-- databases that were created before the background worker existed.
ALTER TABLE trace_jobs ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trace_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE trace_jobs ADD COLUMN IF NOT EXISTS retry_at    TIMESTAMP WITH TIME ZONE;
ALTER TABLE trace_jobs DROP CONSTRAINT IF EXISTS trace_jobs_status_check;
ALTER TABLE trace_jobs ADD CONSTRAINT trace_jobs_status_check
  CHECK (status IN ('queued','running','retry','partial','completed','failed','cancelled'));
CREATE INDEX IF NOT EXISTS trace_jobs_claim_idx ON trace_jobs(status, created_at) WHERE status IN ('queued','retry');

-- Auto-process jobs for fully automated case processing
CREATE TABLE IF NOT EXISTS auto_process_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         UUID REFERENCES cases(id) ON DELETE SET NULL,
  document_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','creating_case','uploading_document','extracting_text','analyzing_document','validating_indicators','applying_indicators','running_traces','building_ledger','generating_risk_alerts','generating_pdf','completed','failed','running','retry','cancelled')),
  progress        JSONB NOT NULL DEFAULT '{}'::jsonb,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  result          JSONB,
  error           TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  started_at      TIMESTAMP WITH TIME ZONE,
  completed_at    TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS auto_process_jobs_status_idx ON auto_process_jobs(status);
CREATE INDEX IF NOT EXISTS auto_process_jobs_case_idx ON auto_process_jobs(case_id);
CREATE INDEX IF NOT EXISTS auto_process_jobs_created_idx ON auto_process_jobs(created_at DESC);

-- Worker retry bookkeeping: park a failed job in 'retry' with a backoff
-- until attempts reaches max_retries.
ALTER TABLE auto_process_jobs ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auto_process_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE auto_process_jobs ADD COLUMN IF NOT EXISTS retry_at    TIMESTAMP WITH TIME ZONE;
CREATE INDEX IF NOT EXISTS auto_process_jobs_claim_idx ON auto_process_jobs(status, created_at) WHERE status IN ('queued','retry');
-- Trace snapshots - immutable records of trace state at specific points
CREATE TABLE IF NOT EXISTS trace_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_job_id  UUID NOT NULL REFERENCES trace_jobs(id) ON DELETE CASCADE,
  trace_id      UUID REFERENCES traces(id) ON DELETE SET NULL,
  snapshot_type TEXT NOT NULL DEFAULT 'auto'
                CHECK (snapshot_type IN ('original','retrace','expanded','provider_update','risk_update')),
  graph         JSONB NOT NULL,
  ledger        JSONB,
  risk_summary  JSONB,
  node_count    INTEGER NOT NULL,
  edge_count    INTEGER NOT NULL,
  risk_score    INTEGER NOT NULL DEFAULT 0,
  risk_level    risk_level NOT NULL DEFAULT 'Unrated',
  description   TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trace_snapshots_job_idx ON trace_snapshots(trace_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trace_snapshots_type_idx ON trace_snapshots(snapshot_type);
