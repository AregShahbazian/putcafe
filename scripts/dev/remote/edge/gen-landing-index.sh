#!/usr/bin/env bash
# Regenerate the root landing page that links every deployed putcafe web build —
# prod at /web/ plus staging and each feature/dev preview under /web/<slot>/.
# Discovered from whatever is on disk under the site root, so it self-heals: each
# deploy re-runs it and the page reflects every accumulated build. Rows are sorted
# newest-first by the build's mtime (i.e. the latest deploy for that slot).
# Ported from Orion's gen-landing-index.sh (web-only — putcafe ships no APKs).
#
#   bash gen-landing-index.sh [site-dir]      # default: /root/putcafe/site
set -euo pipefail
SITE_DIR="${1:-/root/putcafe/site}"
REPO_URL="https://github.com/AregShahbazian/putcafe"

# A slot's deployed commit sha7 — the deploys drop a `.putcafe-sha` marker into dist/
# before rsyncing, so it lands next to the build. Empty for pre-marker deploys.
slot_sha() {
  local dir="$1" sha=""
  [ -f "$dir/.putcafe-sha" ] && sha="$(tr -dc '0-9a-f' < "$dir/.putcafe-sha" | cut -c1-7)"
  echo "$sha"
}

# Emit one "<mtime>\t<li>...</li>" row so the caller can sort by the leading mtime. The
# build's datetime is embedded as a UTC <time> element; the inline script at the foot of
# the page rewrites it into the viewer's browser timezone (UTC text is the no-JS fallback).
row() {
  local mtime="$1" title="$2" web="$3" sha="$4" li when=""
  [ "$mtime" -gt 0 ] && when="<time data-epoch=\"$mtime\">$(date -u -d "@$mtime" '+%Y-%m-%d %H:%M UTC')</time>"
  li="  <li><strong>$title</strong>"
  [ -n "$when" ] && li="$li &mdash; $when"
  [ -n "$sha" ] && li="$li &mdash; <a href=\"$REPO_URL/commit/$sha\"><code>$sha</code></a>"
  li="$li &mdash; <a href=\"$web\">web app</a>"
  printf '%s\t%s</li>\n' "$mtime" "$li"
}

# A slot is any sub-dir of web/ that holds its own index.html (a deployed Vite build).
# The build asset dirs (assets/) have none.
slots() {
  for d in "$SITE_DIR/web"/*/; do
    [ -f "${d}index.html" ] && basename "$d"
  done 2>/dev/null | sort -u
}

{
  echo '<!doctype html><meta charset="utf-8"><title>Putcafe releases</title>'
  cat <<'HTML'
<style>
  body { background: #1b1b1f; color: #d4d4d8; font-family: system-ui, sans-serif; margin: 2rem; }
  a { color: #8ab4f8; }
  code { color: #e8b87d; }
  li { margin: .35rem 0; }
</style>
HTML
  echo '<h2>Putcafe releases</h2><ul>'
  {
    # prod (the /web/ root, deployed by version tags)
    if [ -f "$SITE_DIR/web/index.html" ]; then
      row "$(stat -c %Y "$SITE_DIR/web/index.html")" "prod" "/web/" "$(slot_sha "$SITE_DIR/web")"
    fi
    # staging + preview slots
    for s in $(slots); do
      row "$(stat -c %Y "$SITE_DIR/web/$s/index.html")" "$s" "/web/$s/" "$(slot_sha "$SITE_DIR/web/$s")"
    done
  } | sort -t$'\t' -k1,1nr | cut -f2-      # newest mtime first, drop the sort key
  echo '</ul>'
  # Rewrite each UTC <time> into the viewer's local timezone, client-side.
  cat <<'HTML'
<script>
for (const el of document.querySelectorAll('time[data-epoch]')) {
  const d = new Date(el.dataset.epoch * 1000);
  el.textContent = d.toLocaleString([], {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  el.title = d.toString();
}
</script>
HTML
} > "$SITE_DIR/index.html"
echo "regenerated $SITE_DIR/index.html"
