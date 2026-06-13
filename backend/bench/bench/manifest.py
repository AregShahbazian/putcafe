"""Run manifest — reproducibility / training-provenance record for a benchmark
run (pc-benchmark-runner §3). JSON for machines, .md for humans, under
/data/bench/manifests/. Records the spec, every config_hash, and the
corpus_manifest_ref the sessions replayed against."""

import json
import os
import time

from . import config, spec as spec_mod


def _iso(ts):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts)) if ts else None


def write(sp: spec_mod.Spec, sessions: list, status, manifest_ref) -> str:
    os.makedirs(config.MANIFEST_DIR, exist_ok=True)
    snap = status.snapshot()
    configs = [
        {"config_hash": spec_mod.config_hash(c), "config": c}
        for c in sp.configs()
    ]
    doc = {
        "run_id": snap["run_id"],
        "state": snap["state"],
        "spec": sp.name,
        "started": snap["started"],
        "finished": time.time(),
        "corpus_manifest_ref": manifest_ref,
        "range": sp.range,
        "selector": sp.selector,
        "configs": configs,
        "sessions_total": len(sessions),
        "sessions_done": snap["done"],
        "gaps": snap["gaps"],
        "errors_total": snap["errors_total"],
        "errors": snap["errors"],
    }
    base = os.path.join(config.MANIFEST_DIR, snap["run_id"])
    with open(base + ".json", "w") as f:
        json.dump(doc, f, indent=1)

    lines = [
        f"# Benchmark run `{snap['run_id']}` — {snap['state']}",
        "",
        f"- spec **{sp.name}**, started {_iso(snap['started'])} UTC, "
        f"finished {_iso(doc['finished'])} UTC",
        f"- corpus provenance: `{manifest_ref or '(none)'}`",
        f"- range mode: `{sp.range.get('mode', 'full')}`; "
        f"{len(configs)} config(s); {len(sessions)} sessions, "
        f"{snap['done']} done, {snap['gaps']} gaps, {snap['errors_total']} errors",
        "",
        "## Configs",
        "",
        "| config_hash | algo | config |",
        "|---|---|---|",
    ]
    for c in configs:
        lines.append(
            f"| `{c['config_hash']}` | {c['config']['algo']} | "
            f"`{json.dumps({k: v for k, v in c['config'].items() if k != 'algo'}, separators=(',', ':'))}` |")
    if snap["errors"]:
        lines += ["", "## Errors (sample)", ""]
        lines += [f"- {e}" for e in snap["errors"]]
    lines.append("")
    with open(base + ".md", "w") as f:
        f.write("\n".join(lines))
    return base
