#!/usr/bin/env bash
# 死活監視の URL が {"status":"ok"} を返すまで待つ。返らなければ失敗で終わる。
# 使い方：scripts/check-health.sh <URL> [回数（既定 20）]
set -euo pipefail

url="${1:?URL を指定してください}"
attempts="${2:-20}"

for ((i = 1; i <= attempts; i++)); do
  body="$(curl --silent --show-error --max-time 10 "$url" || true)"
  if [[ "$body" == '{"status":"ok"}' ]]; then
    echo "ok: $url"
    exit 0
  fi
  echo "まだ（${i}/${attempts}）：$url"
  sleep 5
done

echo "応答がありません：$url" >&2
exit 1
