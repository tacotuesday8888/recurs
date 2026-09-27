#!/usr/bin/env bash
# Runs benchmarks/three-way/PROTOCOL.md in order. Start it yourself in a local
# terminal: the Recurs harness requires a user-present session for subscription
# use. It stops at the first usage-limit or billing message, as declared.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=benchmarks/three-way
mkdir -p "$OUT/harness" "$OUT/claude" "$OUT/artifacts"
RECURS=(node dist/cli/main.js)
SOL_ID="${SOL_CONNECTION_ID:-$("${RECURS[@]}" account list | grep 'GPT-5.6-Sol' | grep -oE 'codex-[0-9a-f-]+' | head -1)}"
limit_hit() { grep -qiE "usage limit|rate limit|limit reached|credit balance|purchase credits" "$1"; }
stop() { echo "Stopping: $1. Remaining attempts are reported as not run."; node scripts/three-way-report.mjs; exit 0; }

for task in shipment_quote:1 incremental_build_repair:2 release_window_regressions:1; do
  id=${task%%:*}; version=${task##*:}
  echo "== $id: Codex CLI and Recurs"
  "${RECURS[@]}" benchmark company --configured --allow-network --control codex --scenario "$id" \
    --repetitions 2 --artifacts "$OUT/artifacts" --json > "$OUT/harness/$id.json" 2> "$OUT/harness/$id.log"
  limit_hit "$OUT/harness/$id.log" && stop "usage limit during $id (Codex CLI/Recurs)"
  for attempt in 1 2; do
    echo "== $id: Claude Code attempt $attempt"
    node scripts/three-way-claude-arm.mjs --scenario "$id" --version "$version" --attempt "$attempt" \
      --output "$OUT/claude/$id-$attempt.json" --artifacts "$OUT/artifacts" 2> "$OUT/claude/$id-$attempt.log"
    grep -q '"invalidReason": "subscription usage limit"' "$OUT/claude/$id-$attempt.json" && stop "Claude usage limit during $id"
  done
done

[ -n "$SOL_ID" ] || stop "no GPT-5.6-Sol connection for the team question"
for id in shipment_quote incremental_build_repair release_window_regressions; do
  echo "== $id: Sol alone vs Sol-led team"
  "${RECURS[@]}" benchmark company --configured --allow-network --connection "$SOL_ID" --scenario "$id" \
    --repetitions 2 --artifacts "$OUT/artifacts" --json > "$OUT/harness/team-$id.json" 2> "$OUT/harness/team-$id.log"
  limit_hit "$OUT/harness/team-$id.log" && stop "usage limit during team question ($id)"
done
node scripts/three-way-report.mjs
