"""Shared run state + periodic /data/status.json writer (the `status`/`monitor`
scripts read this). One Status object per run, mutated by exchange workers."""

import asyncio
import json
import os
import time

from . import config

WRITE_EVERY_S = 5


class Status:
    def __init__(self, run_id: str, resolutions: list[str] | None = None):
        self.run_id = run_id
        self.started = time.time()
        self.state = "running"
        self.resolutions = resolutions or config.RESOLUTIONS
        self.exchanges: dict[str, dict] = {}

    def init_exchange(self, ex: str, markets: list[str]):
        self.exchanges[ex] = {
            "state": "running", "markets": markets, "markets_done": 0,
            "current": None, "candles": 0, "gaps": 0,
            "errors": [], "errors_total": 0,
        }

    def snapshot(self) -> dict:
        return {
            "run_id": self.run_id,
            "started": self.started,
            "updated": time.time(),
            "state": self.state,
            "resolutions": self.resolutions,
            "exchanges": self.exchanges,
        }

    def write(self):
        os.makedirs(config.DATA_DIR, exist_ok=True)
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
