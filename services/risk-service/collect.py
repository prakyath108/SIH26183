#!/usr/bin/env python3
"""
Collect traversal contexts from the CryptoTrace database.

Usage:
    python collect.py --out traversals.jsonl [--case-id UUID] [--chain bitcoin] [--limit 500]

The output is JSONL matching the `ScoreRequest` shape expected by `train.py`.
Each line is one root traversal context. The analyst chooses which lines to
include in the training sample — this tool provides the raw material.

Environment (via .env or shell):
    DATABASE_URL        Postgres connection string (required)
    PGPOOL_MAX          Pool size, default 10
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import asyncpg
from dotenv import load_dotenv

# Load .env from repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(REPO_ROOT / ".env")

log = logging.getLogger("collect")


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export traversal contexts for model training."
    )
    parser.add_argument("--out", required=True, type=Path, help="JSONL output path")
    parser.add_argument("--case-id", type=str, help="Filter to a single case")
    parser.add_argument("--chain", type=str, help="Filter to one chain")
    parser.add_argument(
        "--limit", type=int, default=500, help="Max traversals to emit"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL not set. Copy .env.example to .env and fill it.")

    log.info("Connecting to %s", db_url.replace(db_url.split("@")[-1], "@****"))
    pool = await asyncpg.create_pool(db_url, max_size=os.getenv("PGPOOL_MAX", "10"))

    try:
        async with pool.acquire() as conn:
            # Build the query: one row per trace (root traversal)
            where = []
            params: list[Any] = []

            if args.case_id:
                where.append("t.case_id = $%d" % (len(params) + 1))
                params.append(args.case_id)
            if args.chain:
                where.append("t.chain = $%d" % (len(params) + 1))
                params.append(args.chain)

            where_sql = ("WHERE " + " AND ".join(where)) if where else ""

            # Select traces with their root address and hop count
            traces = await conn.fetch(
                f"""
                SELECT
                    t.id AS trace_id,
                    t.root_address,
                    t.chain,
                    t.max_hops,
                    t.direction,
                    t.total_usd,
                    t.risk_score,
                    t.risk_level,
                    t.created_at
                FROM traces t
                {where_sql}
                ORDER BY t.created_at DESC
                LIMIT $%d
                """ % (len(params) + 1),
                *params,
                args.limit,
            )

            if not traces:
                log.info("No traces matched the filters.")
                return 0

            log.info("Found %d traces; computing features...", len(traces))

            out_path = args.out
            out_path.parent.mkdir(parents=True, exist_ok=True)
            written = 0

            async with out_path.open("w", encoding="utf-8") as f:
                for t in traces:
                    ctx = await build_traversal_context(conn, t)
                    if ctx:
                        await f.write(json.dumps(ctx) + "\n")
                        written += 1

            log.info("Wrote %d traversal contexts to %s", written, out_path)
            return 0

    finally:
        await pool.close()


async def build_traversal_context(
    conn: asyncpg.Connection, trace: asyncpg.Record
) -> dict[str, Any] | None:
    """Reproduce the TraversalContext that tracer.ts computes for the root."""
    trace_id = trace["trace_id"]
    root_address = trace["root_address"].lower()
    chain = trace["chain"]

    # Fetch edges for this trace, ordered by timestamp
    edges = await conn.fetch(
        """
        SELECT
            source, target, tx_hash, timestamp, value_usd, value_native
        FROM graph_edges
        WHERE trace_id = $1
        ORDER BY timestamp ASC NULLS LAST
        """,
        trace_id,
    )
    if not edges:
        return None

    # Build adjacency for hop-interval calculation (same logic as tracer.ts:225-233)
    # For each edge, find edges where source == this target, same trace.
    # We'll need timestamps for both edges.
    # Since we already have all edges, we can compute deltas in-memory.
    by_source: dict[str, list[asyncpg.Record]] = {}
    for e in edges:
        by_source.setdefault(e["source"].lower(), []).append(e)

    hop_intervals: list[float] = []
    for e in edges:
        ts = e["timestamp"]
        if not ts:
            continue
        ts_ms = ts.timestamp() * 1000
        target = e["target"].lower()
        for next_e in by_source.get(target, []):
            if next_e["timestamp"]:
                delta = (next_e["timestamp"].timestamp() * 1000 - ts_ms) / 1000.0
                if delta > 0:
                    hop_intervals.append(delta)

    # counterpartyCount = distinct addresses in trace (source + target)
    counterparties = set()
    for e in edges:
        counterparties.add(e["source"].lower())
        counterparties.add(e["target"].lower())
    counterparty_count = len(counterparties)

    # consolidationRatio = counterpartyCount / (edges/2), mirroring tracer.ts:286
    consolidation_ratio = (
        counterparty_count / max(1.0, len(edges) / 2.0) if edges else None
    )

    # bridgeCrossings from bridge_events or node kind
    bridge_crossings = await conn.fetchval(
        """
        SELECT COUNT(*) FROM bridge_events WHERE trace_id = $1
        """,
        trace_id,
    ) or 0

    # Labels are not scored by the model, but we carry them for the server's context
    # if the server ever asks; the model ignores them.
    labels = []

    # analystNotes: we don't have a per-trace note store, so empty
    analyst_notes = []

    ctx = {
        "hopIntervals": hop_intervals,
        "consolidationRatio": consolidation_ratio,
        "counterpartyCount": counterparty_count,
        "totalValueUsd": float(trace["total_usd"] or 0),
        "bridgeCrossings": bridge_crossings,
        "labels": labels,
        "analystNotes": analyst_notes,
        "chain": chain,
        "address": root_address,
        "caseId": str(trace["case_id"]) if trace.get("case_id") else None,
    }
    return ctx


if __name__ == "__main__":
    import asyncio

    raise SystemExit(asyncio.run(main()))