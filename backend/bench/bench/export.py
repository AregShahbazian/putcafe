"""Parquet export of a spec's result rows for downstream ML / NN training
(pc-benchmark-runner §5). Columnar, pandas/NN-friendly; carries config_hash +
corpus_manifest_ref so a training set is fully traceable. Never touches the
canonical stores.

  python -m bench.export <spec>
"""

import argparse
import os

import polars as pl

from . import config, spec as spec_mod, store


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    args = ap.parse_args()

    sp = spec_mod.load(args.spec)
    conn = store.open_db()
    try:
        rows = store.rows_for(conn, [spec_mod.config_hash(c) for c in sp.configs()])
    finally:
        conn.close()
    if not rows:
        raise SystemExit("no results for this spec — run it first")

    df = pl.DataFrame(rows)
    os.makedirs(config.EXPORT_DIR, exist_ok=True)
    out = os.path.join(config.EXPORT_DIR, f"{sp.name}.parquet")
    df.write_parquet(out)
    print(f"{out}: {len(df)} result rows")


if __name__ == "__main__":
    main()
