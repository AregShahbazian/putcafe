"""Benchmark spec — declarative, hashable (pc-benchmark-runner §1).

A spec is committed JSON under specs/. Any list-valued knob in `params`/`pivots`
is a grid axis: all-scalar = a single benchmark; one or more lists = a
benchmark-map (cartesian expansion of configs). Each concrete config has a
stable `config_hash` so results are reproducible and de-dupable."""

import hashlib
import itertools
import json
import os

from . import config


class SpecError(ValueError):
    pass


class Spec:
    def __init__(self, name: str, doc: dict):
        self.name = name
        self.algo = doc.get("algo")
        if not self.algo:
            raise SpecError(f"{name}: missing 'algo'")
        self.param_grid = doc.get("params", {}) or {}
        self.pivot_grid = doc.get("pivots", {}) or {}
        self.selector = doc.get("selector", {}) or {}
        self.range = doc.get("range", {}) or {}

    def configs(self) -> list[dict]:
        """Cartesian expansion of the param/pivot grids → concrete configs.
        Each config = {algo, params{}, pivots{}} with scalar leaves only.
        `params.algoParams` is a nested dict, so its list-valued knobs (e.g.
        `period`) are expanded as additional axes too — that's how indicator
        algos sweep their own parameters in a benchmark-map."""
        params = _expand(self.param_grid)
        pivots = _expand(self.pivot_grid) or [{}]
        out = []
        for p in params or [{}]:
            ap_variants = _expand(p["algoParams"]) if p.get("algoParams") else [None]
            for ap in ap_variants:
                pp = dict(p)
                if ap is not None:
                    pp["algoParams"] = ap
                for pv in pivots:
                    out.append({"algo": self.algo, "params": pp, "pivots": pv})
        return out

    def is_map(self) -> bool:
        """True when the grid expands to more than one config (benchmark-map)."""
        return len(self.configs()) > 1


def _expand(grid: dict) -> list[dict]:
    """Cartesian product over list-valued keys; scalars pass through. A value
    meant to be a literal list (none of ours are) would need wrapping — all our
    knobs are scalars, so a list always means 'sweep these'."""
    if not grid:
        return [{}]
    axes = {k: v for k, v in grid.items() if isinstance(v, list)}
    fixed = {k: v for k, v in grid.items() if not isinstance(v, list)}
    if not axes:
        return [dict(fixed)]
    keys = list(axes)
    out = []
    for combo in itertools.product(*(axes[k] for k in keys)):
        cfg = dict(fixed)
        cfg.update(dict(zip(keys, combo)))
        out.append(cfg)
    return out


def config_hash(cfg: dict) -> str:
    """sha256 of canonical JSON of {algo, params, pivots} — stable across runs,
    sensitive to any knob change."""
    canon = json.dumps(cfg, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()[:12]


def load(name: str) -> Spec:
    path = name if os.path.isabs(name) else os.path.join(config.SPECS_DIR, f"{name}.json")
    if not os.path.exists(path):
        raise SpecError(f"no spec: {path}")
    with open(path) as f:
        return Spec(os.path.splitext(os.path.basename(path))[0], json.load(f))
