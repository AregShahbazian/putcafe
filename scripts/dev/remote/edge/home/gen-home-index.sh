#!/usr/bin/env bash
# Generate the cross-app "home" portal — a single static hub page that links to every
# app running on this box and to each app's own auto-generated "all releases" page
# (which already lists every build slot: prod, staging, each feature/dev preview, APKs).
#
# The output is fully self-contained with ABSOLUTE https URLs, so the SAME file works
# in two places unchanged:
#   * served by Caddy at  home.<ORION_HOST>      (this box)
#   * dropped at the web root of any other static host you own
#
# Because it only links to the per-app release pages (which each deploy regenerates),
# this hub never goes stale — there is nothing to re-run on deploy. Re-run it only if
# ORION_HOST changes (then re-upload any external copy too).
#
#   bash gen-home-index.sh <orion-host> [out-dir]
#     <orion-host>  e.g. <ip-with-dashes>.sslip.io or example.com   (bare host, no scheme)
#     [out-dir]     default /root/home/site        (writes <out-dir>/index.html)
set -euo pipefail
HOST="${1:?usage: gen-home-index.sh <orion-host> [out-dir]}"
OUT_DIR="${2:-/root/home/site}"

ORION="https://$HOST"
PUTCAFE="https://putcafe.$HOST"
OPS="https://ops.$HOST"

mkdir -p "$OUT_DIR"
cat > "$OUT_DIR/index.html" <<HTML
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apps</title>
<style>
  :root { color-scheme: dark; }
  body { background: #1b1b1f; color: #d4d4d8; font-family: system-ui, sans-serif;
         margin: 0; padding: 2.5rem 1.25rem; display: flex; justify-content: center; }
  main { width: 100%; max-width: 46rem; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; font-weight: 600; }
  .card { background: #232329; border: 1px solid #303038; border-radius: 12px;
          padding: 1.1rem 1.25rem; margin: 0 0 1rem; }
  .card h2 { margin: 0 0 .2rem; font-size: 1.15rem; }
  .card p { margin: 0 0 .8rem; color: #9a9aa3; font-size: .9rem; }
  .links { display: flex; flex-wrap: wrap; gap: .5rem; }
  .links a { display: inline-block; padding: .35rem .7rem; border-radius: 8px;
             background: #2d2d35; color: #8ab4f8; text-decoration: none;
             font-size: .88rem; border: 1px solid #383841; }
  .links a:hover { background: #34343d; }
  .links a.primary { background: #8ab4f8; color: #16161a; border-color: #8ab4f8;
                     font-weight: 600; }
  footer { margin-top: 1.75rem; color: #6f6f78; font-size: .8rem; line-height: 1.5; }
  footer a { color: #8ab4f8; }
</style>
<main>
  <h1>Apps</h1>

  <div class="card">
    <h2>Orion</h2>
    <p>Outdoor GPS navigation &amp; mapping &mdash; Flutter (web + Android).</p>
    <div class="links">
      <a class="primary" href="$ORION/web/">Open app</a>
      <a href="$ORION/">All releases</a>
      <a href="$ORION/apk/">Android APKs</a>
    </div>
  </div>

  <div class="card">
    <h2>Putcafe</h2>
    <p>Crypto trading-bot backtesting &amp; replay &mdash; React.</p>
    <div class="links">
      <a class="primary" href="$PUTCAFE/web/">Open app</a>
      <a href="$PUTCAFE/">All releases</a>
    </div>
  </div>

  <footer>
    Each <strong>All releases</strong> page lists every build &mdash; prod, staging and
    feature previews &mdash; and refreshes on every deploy.<br>
    Ops: <a href="$OPS/">container logs</a> (Dozzle, all services on the box).
  </footer>
</main>
HTML
echo "regenerated $OUT_DIR/index.html (host: $HOST)"
