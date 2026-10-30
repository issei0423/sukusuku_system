#!/usr/bin/env bash
# 重いコマンド（npm ci・npm test・vitest・build・go test・Playwright・手元の CI）を、PC の中で1つずつ回すための鍵。
# この PC はメモリが少なく、2つ同時に回すとテストが時間切れで落ちる（2026-10-22）。
#
# 使い方: bash heavy.sh <コマンド…>   （例: bash heavy.sh npm --prefix web test）
#
# 鍵の置き場は、OS の一時フォルダの決まった名前（sukusuku-heavy.lock）。api-agent・Claude Code の係・頭役が同じ鍵を使う。
# 変えるときは環境変数 SUKUSUKU_HEAVY_LOCK にパスを置く。待つ上限（秒）は SUKUSUKU_HEAVY_WAIT（既定 2400）。
# 自分が取った鍵だけを外す（who の1語めが自分の印のときだけ）。
set -u

if [ -n "${SUKUSUKU_HEAVY_LOCK:-}" ]; then
  L="$SUKUSUKU_HEAVY_LOCK"
elif [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
  L="$(cygpath -u "$LOCALAPPDATA")/Temp/sukusuku-heavy.lock"   # Windows（Git Bash）。TMPDIR はセッションごとに違うことがある
else
  L="${TMPDIR:-/tmp}/sukusuku-heavy.lock"
fi
L="${L%/}"

token="$$-${RANDOM}-$(date +%s)"
wait_max="${SUKUSUKU_HEAVY_WAIT:-2400}"
waited=0
until mkdir "$L" 2>/dev/null; do
  sleep 15
  waited=$((waited + 15))
  if [ "$waited" -ge "$wait_max" ]; then
    echo "heavy.sh: $((wait_max / 60)) 分待っても鍵が空かない（$L）。持っているもの：" >&2
    cat "$L/who" >&2 2>/dev/null
    echo "動いていないなら、持ち主か頭役が見て外す。" >&2
    exit 99
  fi
done
# who は1行にする。複数行のコマンド（bash -c の中身など）をそのまま書くと、release の照合が行ごとになり、
# 鍵が外れずに残った（2026-10-31）
printf '%s %s %s\n' "$token" "$(date +%H:%M)" "$(printf '%s' "$*" | tr '\r\n' '  ')" > "$L/who"

release() {
  if [ "$(head -n 1 "$L/who" 2>/dev/null | cut -d' ' -f1)" = "$token" ]; then
    rm -f "$L/who"
    rmdir "$L" 2>/dev/null
  fi
}
trap release EXIT
trap 'exit 130' INT TERM

"$@"
