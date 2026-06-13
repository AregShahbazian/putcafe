"""Run state + periodic /data/bench/status.json writer (the status/monitor
scripts read this). One Status per run, mutated by the runner as sessions land."""

import asyncio
import json
import os
import time

from . import config

WRITE_EVERY_S = 5
MAX_ERRORS_LOGGED = 25


class Status:
    def __init__(self, run_id: str, spec_name: str, total: int, configs: int):
        self.run_id = run_id
        self.spec = spec_name
        self.started = time.time()
        self.state = "running"
        self.total = total
        self.configs = configs
        self.done = 0
        self.gaps = 0
        self.errors_total = 0
        self.errors: list[str] = []
        self.current: str | None = None

    def record_error(self, msg: str):
        self.errors_total += 1
        if len(self.errors) < MAX_ERRORS_LOGGED:
            self.errors.append(msg)

    def snapshot(self) -> dict:
        return {
            "run_id": self.run_id, "spec": self.spec, "state": self.state,
            "started": self.started, "updated": time.time(),
            "total": self.total, "configs": self.configs, "done": self.done,
            "gaps": self.gaps, "errors_total": self.errors_total,
            "errors": self.errors, "current": self.current,
        }

    def write(self):
        os.makedirs(config.BENCH_DIR, exist_ok=True)
        tmp = config.STATUS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.snapshot(), f, indent=1)
        os.replace(tmp, config.STATUS_FILE)


async def writer(status: Status, stop: asyncio.Event):
    while not stop.is_set():
        status.write()
        try:
            await asyncio.wait_for(stop.wait(), WRITE_EVERY_S)
        except asyncio.TimeoutError:
            pass
    status.write()
