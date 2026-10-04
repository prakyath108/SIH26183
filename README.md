# CryptoTrace AI — Full-Stack Blockchain Forensics Platform

A production-grade investigation workspace for authorised blockchain fraud analysis. This is **not a prototype** — it is a complete full-stack application with authentication, RBAC, bounded tracing, evidence management, explainable risk scoring, and tamper-evident audit logging.

## Quick Start

```bash
# Requirements: Node.js 20+, npm
git clone <this-repo>
cd cryptotrace-ai
npm install               # installs server + web workspaces
npm run db:reset          # creates embedded PGlite database (zero-config)
npm run db:migrate        # applies schema
npm run db:seed           # seeds 4 users + 3 cases + sample data
npm run build             # builds the SPA into web/dist
powershell -ExecutionPolicy Bypass -File ./start-server.ps1   # hosts everything
```

Open http://localhost:8080 and sign in with any seeded account:

| Email | Password | Role | Display name |
|-------|----------|------|--------------|
| admin@cryptotrace.local | `SEED_ADMIN_PASSWORD` (default `ChangeMe!2026Admin`) | admin | Agent Chen |
| investigator@cryptotrace.local | Investigate!2026x | investigator | Agent Miller |
| analyst@cryptotrace.local | Analyse!2026xy | analyst | Investigator Yuki |
| viewer@cryptotrace.local | Observe!2026xyz | viewer | Analyst Rodriguez |

> **These are demo credentials published in this file.** Rotate or deactivate
> every one of them before the app is reachable by anyone but you.

To run it in containers instead — which is how you would deploy it — see
[Hosting with Docker](#hosting-with-docker).

## Architecture

```
cryptotrace-ai/
├── Dockerfile         # 4-stage build → single image running API + SPA
├── .dockerignore      # keeps secrets, node_modules, dist, and PGlite data out
├── docker-compose.yml # app + postgres, plus an opt-in `tls` proxy profile
├── .env.docker.example# container secrets template (copy to .env.docker)
├── deploy/
│   ├── Caddyfile      # automatic HTTPS + CSP/HSTS (the `tls` profile)
│   └── nginx.conf     # alternative for existing nginx or external certs
├── start-server.ps1   # local single-origin host, no Docker
├── server/          # Express + TypeScript API
│   ├── src/
│   │   ├── index.ts            # app wiring, CORS, health, static SPA, PDF export
│   │   ├── config.ts           # env parsing + production secret validation
│   │   ├── security.ts         # permission matrix, canonical JSON, SHA-256
│   │   ├── logger.ts           # structured JSON logs (requestId only, no PII)
│   │   ├── paths.ts            # data / dist path resolution
│   │   ├── middleware/         # auth, RBAC, audit, errors
│   │   ├── routes/             # 10 route modules (REST + auth)
│   │   ├── chains/             # Bitcoin/EVM/Tron data clients + address detection
│   │   ├── trace/              # bounded multi-hop graph tracer
│   │   ├── risk/               # explainable rule engine + aggregation service
│   │   ├── reports/            # PDF builder
│   │   ├── db/                 # PGlite / pg adapter, schema, migrate, seed, reset
│   │   └── types.ts            # shared response contracts
│   └── scripts/                 # end-to-end smoke test + PGlite/schema probes
└── web/             # React 18 + Vite 6 + TypeScript SPA
    ├── src/
    │   ├── lib/                # api client, auth, hooks, format, normalize, toasts
    │   ├── components/         # design system, Layout, GraphView, RiskPanel, charts
    │   ├── pages/              # 15 page components (12 modules + detail, login, 404)
    │   ├── styles.css          # responsive design system (CSS variables)
    │   └── types.ts            # frontend API contracts
    └── index.html
```

### Technology Choices

| Layer | Stack | Rationale |
|-------|-------|-----------|
| Runtime | Node 20, TypeScript 5 (ESM) | Strict types end-to-end |
| Database | PGlite (embedded WASM Postgres) / `node-postgres` | Zero-install dev, production parity |
| Auth | JWT (RS256-ready) + rotating refresh tokens, 15 permissions | Stateless, revocable, short-lived access |
| Frontend | React 18, React Router 7, Vite 6 | Modern, fast HMR, code-split routes |
| Styling | Pure CSS (custom properties, fluid type, dark-first) | No framework lock-in; 38 kB built, 8 kB gzipped |
| Chain data | mempool.space (BTC), Cloudflare Eth RPC, TronGrid | No API keys required for read paths |
| Tracing | Deterministic BFS with hop/node/edge/time bounds | Reproducible, partial results marked |
| Risk | Weighted rules + confidence discount + saturating curve | Transparent, configurable, auditable |

## Modules Implemented

All 12 modules from the specification are complete and connected to the API:

1. **Dashboard** — Case metrics, risk distribution donut, activity sparkline, open alerts, chain health.
2. **Investigations** — Paginated list with filters, create modal, detail view with entities, transactions, evidence, notes, traces, assignees.
3. **Blockchain Explorer** — Address / tx hash lookup across Bitcoin, Ethereum, Polygon, Tron. Normalised transaction table with USD where priced.
4. **Fund Flow** — Run bounded traces, interactive SVG graph (risk-coloured nodes, hop layout), node detail sidebar, table fallback, truncation badges.
5. **VASP Intelligence** — Label CRUD (exchange/mixer/bridge/sanctioned/darknet/service), challenge workflow, entity sync, CSV export.
6. **Risk Analytics** — Per-rule weights (overridable), thresholds, distribution chart, limitations panel, disclaimer.
7. **Alerts** — Severity/state triage, acknowledge/resolve with reason, scan trigger, CSV export.
8. **Reports & Evidence** — Evidence register with SHA-256 verification, case report preview, PDF export with methodology/limitations sections.
9. **Integrations** — Chain node health, enable/disable, auth type, rate limits, add/edit modal.
10. **Team** — Member table, role capabilities matrix, per-user activity log.
11. **Audit Logs** — Filterable table (actor, action, entity, outcome, date range), append-only guarantee via DB trigger, CSV export.
12. **Administration** — User management (create/deactivate/reset password/role change), permission matrix, risk weight overrides, system stats (table counts, uptime).

## Security & Compliance

- **Authentication** — Access tokens (15 min, `JWT_EXPIRES_IN`) + single-use rotating refresh tokens (7 days, `JWT_REFRESH_TTL_DAYS`). Tokens hashed in DB; revocation on logout, deactivation, and password change.
- **Refresh token reuse detection** — A rotated refresh token is never accepted twice. Presenting one again is treated as theft: every session for that user is revoked and an `auth.refresh_reuse` entry is written to the audit log. Because the check is unconditional, the web client must not resend a rotated token — `api.ts` re-reads storage before refreshing so a second tab cannot present a stale one.
- **Login throttling** — Two independent budgets in the `login_attempts` table, both enforced through the shared database rather than process memory, so they survive restarts and are consistent across instances: 20 attempts per **account** per 10 minutes (follows the account, so rotating source addresses buys an attacker nothing) and 60 per **source address** (stops one host spraying many accounts). A successful sign-in clears the account budget only.
- **Secret validation** — Production startup refuses `JWT_SECRET` values that are shorter than 32 characters, low in distinct characters, or contain a placeholder fragment. Both the schema minimum and the `config.ts` check are in force.
- **Authorisation** — Every route guarded by `requirePermission`. Frontend mirrors server permissions for nav gating.
- **Audit Trail** — All mutating operations write an append-only `audit_log` row (trigger-enforced immutability). CSV export for reviewers.
- **Evidence Integrity** — SHA-256 over canonical JSON at collection; verification endpoint recomputes and compares.
- **Risk Transparency** — Each factor shows source, `observed_at`, confidence, and limitations. Scores are triage aids, **not findings of fact**.
- **No PII in Logs** — Structured JSON logs include `requestId` only.

> **Legal disclaimer:** This software assists authorised investigators. It does not establish identity, wrongdoing, or legal liability. Wallet addresses are pseudonymous; third-party labels are unverified claims. All outputs require independent corroboration before legal/regulatory reliance.

## Environmental Dependencies

| Feature | Requires |
|---------|----------|
| Ethereum address history | `ETHERSCAN_API_KEY` in server env |
| USD pricing | External price feed (not configured — USD stays `null`, UI shows “not priced”) |
| Production DB | `DATABASE_URL=postgres://…` (otherwise PGlite at `server/data/pg`) |
| TLS / HTTPS | Reverse proxy (nginx/Caddy) or cloud load balancer |
| **AI document analysis & chat** | `OPENAI_API_KEY` + `AI_ENABLED=true` (model defaults to `gpt-4o-mini`) |

Without `ETHERSCAN_API_KEY`, Ethereum/Polygon address history returns “history unavailable” (balance/nonce still work). This is **intentional** — the platform degrades gracefully rather than failing silently.

### AI assistant configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPENAI_API_KEY` | *(unset)* | OpenAI secret key. If absent, the assistant reports `available: false` and the panel shows a configuration note. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Any model supporting JSON schema strict mode and structured outputs. |
| `AI_ENABLED` | `true` | Master switch. Set `false` to disable the assistant entirely. |
| `AI_MAX_UPLOAD_MB` | `20` | Maximum document size. Larger uploads are rejected at the edge. |
| `AI_MAX_INPUT_CHARS` | `60000` | Ceiling for extracted text per document. Longer PDFs are truncated with page markers preserved. |
| `AI_TIMEOUT_MS` | `90000` | Per-call timeout against the model provider. |
| `AI_MAX_CONCURRENT` | `3` | Concurrency gate for simultaneous analyses. Excess requests return 429. |

All AI routes require authentication and the corresponding permission (`ai:read`, `ai:upload`, `ai:apply`). No model output writes to the database without a human pressing **Apply**, and every blockchain identifier is re-validated against the platform's own chain detection before storage.

Without `ETHERSCAN_API_KEY`, Ethereum/Polygon address history returns “history unavailable” (balance/nonce still work). This is **intentional** — the platform degrades gracefully rather than failing silently.

## Database

### Embedded (default)

PGlite stores a real Postgres database in `server/data/pg/`. No Docker, no service. Schema auto-applies on start.

```bash
npm run db:reset   # wipes + reinitialises
npm run db:migrate # applies schema.sql
npm run db:seed    # deterministic seed (idempotent)
```

> **Lost a seeded password?** `db:seed` never overwrites `password_hash` — its
> upsert updates display name, role and agency only, so re-seeding cannot restore
> a password that has been changed. Use `npm run user:reset-password -- <email>`
> instead of `db:reset`, which discards every case, note and evidence item.

### External Postgres

```bash
export DATABASE_URL="postgres://user:pass@host:5432/cryptotrace"
npm run db:migrate
npm run db:seed
```

Schema highlights:
- `cases`, `case_entities`, `case_transactions`, `case_notes`, `case_assignees`, `traces`
- `entities` (address + chain + risk + labels)
- `labels` (VASP attributions with challenge workflow)
- `evidence` (kind, title, `content_sha256`, chain-of-custody)
- `alerts`, `integrations`, `audit_log` (append-only trigger)
- `users`, `refresh_tokens` (hashed, revocable, `revoked_reason`), `login_attempts` (throttle counters)

## Hosting with Docker

The recommended way to run this anywhere is the two-service Compose stack: the
API and SPA in one image, Postgres in another. It runs identically on a laptop,
a VPS, Fly, Railway, or Render.

```bash
cp .env.docker.example .env.docker
# set JWT_SECRET and POSTGRES_PASSWORD in it — see below

docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker exec app node server/dist/db/seed.js   # first run
```

Open http://localhost:8080. The app applies the schema on boot, so migration is
not a separate step.

> **Use `--env-file .env.docker` explicitly.** Compose otherwise auto-loads the
> development `.env` at the repo root and would silently substitute those values
> into the production container.

### Why Postgres and not PGlite in a container

PGlite keeps a real Postgres data directory on local disk. A container loses
that on every rebuild, so cases, notes, and audit rows would vanish. Setting
`DATABASE_URL` is what switches the driver (`server/src/db/index.ts`); the
Compose file sets it, and the data lives in the named `pgdata` volume. Verified
by destroying and recreating both containers — seeded cases survive.

### Layout

The image is Debian-based (`node:22-slim`) rather than Alpine because `argon2`
is a native addon and musl forces a source build. It builds in four stages —
`deps` → `build` → `prod-deps` → `runtime` — so the ~1 GB of dev tooling never
reaches the final image (~390 MB). The final stage runs as the non-root `node`
user, and the monorepo layout is preserved because the server finds the SPA by
resolving `../../web/dist` relative to its own compiled file.

### Container notes

| Concern | Behaviour |
|---------|-----------|
| Health | `HEALTHCHECK` polls `/api/health`, which returns 503 `degraded` when the database is unreachable |
| Startup | `depends_on: service_healthy` — no crash-loop against a cold Postgres |
| Signals | `CMD` is `node`, not `npm run`, so SIGTERM reaches the graceful shutdown handler |
| Schema | Compiled to `server/dist/db/schema.sql`, where `migrate()` reads it |
| Secrets | `JWT_SECRET` is required (`:?`); the app also re-validates it at boot and refuses weak values |
| Ports | Published on `127.0.0.1` only. Set `CRYPTOTRACE_PORT` to run alongside a local instance |

The `db:*` scripts are compiled into the image, so they run without `tsx`:

```bash
docker compose --env-file .env.docker exec app node server/dist/db/seed.js
docker compose --env-file .env.docker exec app node server/dist/db/reset-password.js admin@cryptotrace.local
```

### TLS termination

The app speaks plain HTTP, so something must terminate TLS in front of it. Both
options set the same CSP and HSTS headers; the app deliberately disables
helmet's CSP (`server/src/index.ts`) because the static host is expected to own
it, and that host is the proxy.

**Caddy** — certificates are obtained and renewed automatically, with no
certbot and no cron. Opt in with the `tls` profile:

```bash
# In .env.docker:
#   DOMAIN=cryptotrace.example.com   # must resolve to this host, publicly
#   ACME_EMAIL=you@example.com       # Let's Encrypt expiry notices

docker compose --env-file .env.docker --profile tls up -d --build
```

```bash
# Staging check with no public domain: ACME_EMAIL=internal switches Caddy to
# its own local CA, so the whole path can be exercised offline.
```

`deploy/Caddyfile` holds the config. Ports 80 and 443 are the only ones meant
to face the internet; the app's own port stays loopback-bound. Set
`PROXY_BIND=127.0.0.1` when a cloud load balancer already terminates TLS, so
only the balancer can reach the proxy.

**nginx** — for existing nginx, or certs from cert-manager, certbot, or an
internal CA. `deploy/nginx.conf` is a complete server block with the matching
headers and a 150s proxy timeout (the tracer's budget is up to 120s). It expects
certificates at `/etc/nginx/certs/cryptotrace.{crt,key}`.

### The CSP, and why it is safe at `'self'`

The built SPA has no inline `<script>`, no `<style>` tags, no iframes, no
external fonts or images, and no WebSockets, so a strict policy genuinely fits
rather than being aspirational:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'; form-action 'self'; frame-src 'none'
```

This was verified rather than assumed. Headless Chrome loads the app through the
proxy with a `securitypolicyviolation` listener installed before the first
parse: React mounts, the stylesheet loads, and the app reports **zero**
violations. React applies its `style={{…}}` props through CSSOM
(`element.style`), which CSP does not police — only inline style *attributes* —
so `style-src 'self'` is safe despite the 29 inline-styled components.

## Case Lifecycle & Closure

```
Open ──▶ In Progress ──▶ Under Review ──▶ Escalated ──▶ Closed
  ▲                                                          │
  └──────────────────── reopen (case:close) ─────────────────┘
```

- **One stage at a time.** The API refuses a status change that skips a stage or moves backwards
  (`server/src/types.ts` holds the flow; `applyStatusChange` in `server/src/routes/cases.ts` enforces it).
  Closing is the one exception — an investigation can be closed from any open stage, because escalation
  is not a precondition for finishing one.
- **Closing is a separate grant.** `case:close` belongs to `investigator` and `admin` only. Analysts can
  work a case but cannot end it; the interface shows the close control disabled with the reason rather
  than omitting it.
- **Closure is a decision, not a status.** Closing requires a written outcome (≥ 10 characters) and
  records `closed_at`, `closed_by` and `closure_note` on the case row, a pinned note on the case
  timeline, and a `case.close` entry in the append-only audit log.
- **Readiness is checked first.** `GET /api/cases/:id/closure-readiness` reports blockers
  (unresolved critical/high alerts) and advisories (no evidence sealed, no trace, no finding written
  up). Blockers refuse the close; a closer may override them with `acknowledgeBlockers`, and both the
  refused attempt (`case.close_blocked`) and the accepted override land in the audit log.
- **Reopening never erases.** `POST /api/cases/:id/reopen` returns the case to `Open` and appends a
  `case.reopen` entry; the earlier closure record remains in the log.

| Endpoint | Permission | Purpose |
|----------|-----------|---------|
| `GET /api/cases/:id/closure-readiness` | `case:read` | Why the case can or cannot be closed now |
| `POST /api/cases/:id/close` | `case:close` | Close with a written outcome |
| `POST /api/cases/:id/reopen` | `case:close` | Reopen a closed case |
| `PATCH /api/cases/:id` | `case:write` | Edit fields; `status` follows the same flow rules |

## Development

```bash
# Typecheck both workspaces
npm run typecheck

# Lint (ESLint 9, typescript-eslint)
npm run lint

# Reset a password you no longer have. Generates one if you omit it.
# Refuses to run in production or against a non-local database.
npm run user:reset-password -- viewer@cryptotrace.local
npm run user:reset-password -- viewer@cryptotrace.local 'NewPass!2026abc'

# Build production bundles
npm run build

# Run smoke test against a running server
node server/scripts/smoke.mjs

# Start API only (port from .env, default 8080)
npm run dev:server

# Start Vite only (HMR; proxies /api to VITE_API_PROXY)
npm run dev:web
```

### API Contracts

All endpoints are typed in `server/src/types.ts` and mirrored in `web/src/types.ts`. Key patterns:

- `GET /api/cases` — paginated, searchable, filterable
- `POST /api/cases/:id/close` — close a case with a written outcome (`case:close`)
- `GET /api/cases/:id/closure-readiness` — blockers and advisories before closing
- `POST /api/chain/trace` — bounded trace request
- `GET /api/chain/lookup` — detect + normalise address/tx
- `POST /api/vasp/labels` — create label (requires `label:challenge`)
- `GET /api/reports/cases/:id/export.pdf` — streaming PDF
- `GET /api/audit` — filterable, CSV via `Accept: text/csv`

Run the smoke test for a full contract walk-through.

## Project Layout for Contributors

```
Dockerfile           # deps -> build -> prod-deps -> runtime; non-root, HEALTHCHECK
.dockerignore        # excludes .env, node_modules, dist, data/ from the context
docker-compose.yml   # app (this image) + postgres 16 + opt-in Caddy proxy
.env.docker.example  # copy to .env.docker and set JWT_SECRET + POSTGRES_PASSWORD
deploy/
  Caddyfile          # automatic HTTPS, CSP, HSTS; `tls` profile
  nginx.conf         # alternative reverse proxy for existing nginx / own certs
server/
  src/
    index.ts          # app wiring, CORS, health, static SPA, PDF export route
    config.ts         # env parsing, production JWT_SECRET validation
    security.ts       # PERMISSIONS matrix, canonical JSON, SHA-256, safeEqual
    logger.ts         # structured JSON logging
    paths.ts          # data / dist path resolution
    routes/
      auth.ts         # login, refresh, me, change-password, logout
      cases.ts        # CRUD + entities + txs + notes + assignees + close/reopen
      chain.ts        # detect, lookup, address txs, health, run trace
      vasp.ts         # labels CRUD + challenge workflow
      reports.ts      # case report JSON, risk rules, export metadata
      admin.ts        # users, permissions, risk config, integrations, system
      audit.ts        # log query + CSV
      team.ts         # members, activity
      alerts.ts       # list, acknowledge, resolve, scan
      evidence.ts     # register, verify, live capture
    chains/
      base.ts         # shared client types and fetch helpers
      bitcoin.ts      # mempool.space client
      ethereum.ts     # Cloudflare RPC client (Etherscan for history)
      tron.ts         # TronGrid client
      detect.ts       # address / tx-hash chain identification
    trace/
      tracer.ts       # BFS with budgets, risk factors, totals
    risk/
      engine.ts       # rule evaluation, weights, thresholds
      service.ts      # aggregation + persistence for risk reads
    reports/
      pdf.ts          # dependency-free PDF writer for case reports
    db/
      index.ts        # PGlite / pg adapter, one/many/findCaseByIdOrRef
      schema.sql      # full DDL + indexes + audit trigger
      migrate.ts      # apply schema.sql
      seed.ts         # deterministic demo data
      reset.ts        # wipe + reinitialise embedded database
      reset-password.ts  # out-of-band password recovery
    middleware/
      auth.ts         # JWT verify, requirePermission, audit context
      error.ts        # HttpError, asyncRoute, errorHandler
      audit.ts        # automatic audit on mutating routes
  scripts/            # smoke.mjs (contract walk-through) + PGlite/schema probes
web/
  src/
    lib/
      api.ts          # typed fetch wrapper, token refresh, download
      auth.tsx        # AuthProvider, useAuth, Protected, can/canAny
      hooks.ts        # useQuery, useDebounced, useLocalStorage
      format.ts       # dateTime, relative, num, usd, native, shortId
      normalize.ts    # chain response → NormalizedTransaction
      toast.tsx       # toast provider + useToast
    components/
      ui.tsx          # design system primitives
      Layout.tsx      # shell, sidebar nav, role-gated links
      CaseFlow.tsx    # case stage stepper + status transitions
      CloseCaseModal.tsx  # closure readiness, blockers, written outcome
      GraphView.tsx   # SVG fund-flow graph (deterministic layout)
      RiskPanel.tsx   # factor list + disclaimer
      charts.tsx      # Donut, Bar, ThresholdScale (canvas, no deps)
    pages/
      Login.tsx, Dashboard.tsx, Investigations.tsx, CaseDetail.tsx,
      Explorer.tsx, FundFlow.tsx, Vasp.tsx, Risk.tsx, Alerts.tsx,
      Reports.tsx, Integrations.tsx, Team.tsx, Audit.tsx,
      Admin.tsx, NotFound.tsx
```

## Production Checklist

- [ ] Set `DATABASE_URL` to managed Postgres (the Compose stack does this; a bare `node dist/index.js` needs it set)
- [ ] Configure `ETHERSCAN_API_KEY` (or alternative EVM indexer)
- [ ] Add price feed for USD conversion
- [ ] Generate RS256 keypair, set `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`
- [ ] Generate `JWT_SECRET` (≥32 chars, high entropy) — startup refuses weak values
- [ ] Set `CORS_ORIGIN` to the real origin once a hostname is in front
- [ ] Put behind TLS-terminating reverse proxy — `deploy/Caddyfile` or `deploy/nginx.conf`, via the `tls` profile
- [ ] Rotate seeded credentials, disable/remove demo accounts
- [ ] Enable CSP, HSTS, secure cookies — CSP and HSTS are set by both proxy configs; the app sets its own cookie flags
- [ ] Set a real `DOMAIN` and `ACME_EMAIL` (`internal` gives a local-CA staging check)
- [ ] Confirm `PROXY_BIND` is right for the setup (`0.0.0.0` direct, `127.0.0.1` behind a load balancer)
- [ ] Configure log aggregation (structured JSON output ready)
- [ ] Confirm `.env` and `.env.docker` are git-ignored and never committed
- [ ] Run `npm run typecheck && npm run build` in CI
- [ ] Execute `node server/scripts/smoke.mjs` in staging

## License

Proprietary — for authorised evaluation only. Not for redistribution.