"""Benchmark-runner config (pc-benchmark-runner). Paths mirror the scraper's
/data layout; results + provenance live under /data/bench/ so the canonical
candle shards (/data/<exchange>.db) are never touched."""

import os

BOT_URL = os.environ.get("BOT_URL", "http://bot:8102")

DATA_DIR = os.environ.get("DATA_DIR", "/data")
BENCH_DIR = os.path.join(DATA_DIR, "bench")
RESULTS_DB = os.path.join(BENCH_DIR, "results.db")
STATUS_FILE = os.path.join(BENCH_DIR, "status.json")
MANIFEST_DIR = os.path.join(BENCH_DIR, "manifests")
EXPORT_DIR = os.path.join(BENCH_DIR, "exports")

# Scrape provenance lives at the corpus root (written by the scraper).
CORPUS_MANIFEST_DIR = os.path.join(DATA_DIR, "manifests")

# Committed specs ship in the image next to the package.
SPECS_DIR = os.environ.get(
    "SPECS_DIR", os.path.join(os.path.dirname(os.path.dirname(__file__)), "specs"))

RESOLUTION_S = {"1m": 60, "1h": 3_600, "1d": 86_400}

SESSION_CAP = int(os.environ.get("BENCH_SESSION_CAP", "10000"))
CONCURRENCY = int(os.environ.get("BENCH_CONCURRENCY", "8"))
RUN_TIMEOUT_S = int(os.environ.get("BENCH_RUN_TIMEOUT_S", "120"))
