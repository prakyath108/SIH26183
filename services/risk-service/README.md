# Advisory Risk Service

A separate microservice that produces a second opinion on blockchain traversal risk.
The rule engine remains authoritative; this service is advisory only.

## Why a separate service

- Different tech stack (Python/scikit-learn vs TypeScript)
- Independent scaling and failure domain
- Clear contract: `ready:false, score:null` is a valid steady state — no fabricated scores

## Model

Unsupervised `IsolationForest` trained on a sample of **routine** traversals.
It learns the shape of normal activity and scores distance from it.

**It is not a supervised model** — this system has no outcome labels (case status is
workflow, not criminality). It cannot learn "what criminal looks like"; it only
learns "what routine looks like" and flags deviations.

The score is a **percentile rank** against the training sample, not an absolute
risk level. Routine traffic centres at 50 by construction. Bands describe rarity,
not severity:

| score | band | routine traffic above it |
|---|---|---|
| <50 | Typical | — |
| ≥50 | Above typical | ~50% |
| ≥75 | Unusual | ~25% |
| ≥90 | Rare | ~10% |
| ≥97 | Very rare | ~3% |

Bands are operator-adjustable via `RISK_BAND_EDGES`/`RISK_BAND_LABELS` without
a rebuild. An unparseable override falls back to defaults rather than silently
reshaping every label.

`calibrated` is always `false` until analyst-reviewed outcome labels exist.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Liveness + readiness (`ready:false` = no model fitted) |
| GET | `/v1/model` | Model metadata + band edges |
| POST | `/v1/score` | Score one traversal (see `ScoreRequest`) |

### ScoreRequest (mirrors server's TraversalContext)

```json
{
  "hopIntervals": [12, 40],
  "consolidationRatio": 0.7,
  "counterpartyCount": 14,
  "totalValueUsd": 250000,
  "bridgeCrossings": 1,
  "labels": [{"kind": "exchange", "confidence": "high"}],
  "analystNotes": []
}
```

### ScoreResponse

```json
{
  "ready": false,
  "score": null,
  "level": null,
  "calibrated": false,
  "bandBasis": "Percentile of the model's training-sample margin distribution...",
  "modelVersion": null,
  "trainedAt": null,
  "featureNames": [...],
  "caveat": "Advisory model output for triage ordering only..."
}
```

When `ready:false`, `score` and `level` are `null` — never a fabricated number.

## Training

```bash
cd services/risk-service
python train.py --input routine_traversals.jsonl --out models/risk.joblib
```

**Input:** JSONL, one `ScoreRequest` per line. Must be a sample of *routine* traffic.
If the sample contains suspicious cases, the model inverts: "normal" becomes
"suspicious" and every score inverts. The `--contamination` flag (default 0.05)
is the expected alert rate on traffic resembling the sample — it is logged and
stored as `alertRateHint`.

**Output:** `models/risk.joblib` with pipeline, feature names, version, and
out-of-fold margins for the rank transform.

The service refuses to score until a model is fitted. This is correct: a missing
model is an honest "no advisory" state, not an outage.

## Collecting a sample

```bash
cd services/risk-service
python collect.py --out traversals.jsonl --limit 500
```

Requires `DATABASE_URL` in `.env` (see `.env.example`). Emits traversal contexts
for every trace in the database (or filtered by `--case-id`/`--chain`). The
analyst curates the output — keeps only routine cases, discards suspicious ones.

## Auditing a sample

```bash
python audit.py traversals.jsonl [--model models/risk.joblib]
```

Reports feature distributions, label counts, and (if `--model` given) the
implied flag rate. If the flag rate far exceeds `--contamination`, the sample
is not routine.

## Deployment

Docker (from repo root):

```bash
docker compose --env-file .env.docker up -d --build
```

The service starts unready. To enable scoring, train a model and mount it:

```yaml
services:
  risk:
    build: ./services/risk-service
    volumes:
      - risk_models:/app/models
```

Then set `RISK_SERVICE_URL=http://risk:8099` in `.env.docker` and restart.

Band overrides without a rebuild:

```yaml
environment:
  RISK_BAND_EDGES: "50,75,90,97"
  RISK_BAND_LABELS: "Typical,Above typical,Unusual,Rare,Very rare"
```

Invalid overrides degrade to defaults (logged), never reshape labels silently.

## Contract with the server

The server calls `/v1/score` with a 1.5s timeout, fails open (treats any error as
"no advisory"), and attaches the advisory to root assessments only — never
blended into the rule score, never called per graph node.

The rule engine's `score`/`level` remain the assessment; the advisory is a
second opinion shown alongside it.

## Why structural-only features

The model deliberately excludes `label_*` and `analyst_note_count` features.
The rule engine already scores sanctions, mixers, and darknet exposure
authoritatively. Feeding the same labels to the model would count the same
evidence twice, and an IsolationForest trained on routine data cannot split on a
constant-zero column anyway — a case carrying a high-confidence OFAC hit would
score *below* average (real miss found during development). Structural features
(timing, fan-out, consolidation, value spread) are what the rules don't cover.