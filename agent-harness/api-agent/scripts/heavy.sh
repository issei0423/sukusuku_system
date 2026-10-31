#!/usr/bin/env bash
# 重いコマンド（npm ci・npm test・vitest・build・go test・Playwright・手元の CI）を、PC の中で1つずつ回すための鍵。
# この PC はメモリが少なく、2つ同時に回すとテストが時間切れで落ちる（2026-10-22）。
#
# 使い方: bash heavy.sh <コマンド…>   （例: bash heavy.sh npm --prefix web test）
#
# 鍵の置き場は、OS の一時フォルダの決まった名前（sukusuku-heavy.lock）。api-agent・Claude Code の係・頭役が同じ鍵を使う。
# 変えるときは環境変数 SUKUSUKU_HEAVY_LOCK にパスを置く。待つ上限（秒）は SUKUSUKU_HEAVY_WAIT（既定 2400）。
# 自分が取った鍵だけを外す（who の1語めが自分の印のときだけ）。
# ただし、持ち主のプロセスが居なくなった鍵（SIGKILL や Windows の TerminateProcess で trap が走らずに残ったもの）は、
# 鍵を取ってから SUKUSUKU_HEAVY_STALE 秒（既定 120）たっていれば、待つ側が外して取り直す（2026-10-31）。
# 持ち主が生きている鍵は、どれだけ長くても外さない（待つ上限で 99）。鍵を見直す間隔（秒）は SUKUSUKU_HEAVY_POLL（既定 15）。
set -u

if [ -n "${SUKUSUKU_HEAVY_LOCK:-}" ]; then
  L="$SUKUSUKU_HEAVY_LOCK"
elif [ -n "${LOCALAPPDATA:-}" ] && command -v cygpath >/dev/null 2>&1; then
  L="$(cygpath -u "$LOCALAPPDATA")/Temp/sukusuku-heavy.lock"   # Windows（Git Bash）。TMPDIR はセッションごとに違うことがある
else
  L="${TMPDIR:-/tmp}/sukusuku-heavy.lock"
fi
L="${L%/}"

me="$$-${RANDOM}"
wait_max="${SUKUSUKU_HEAVY_WAIT:-2400}"
stale_after="${SUKUSUKU_HEAVY_STALE:-120}"
poll="${SUKUSUKU_HEAVY_POLL:-15}"

# 持ち主のプロセスが生きているか。Git Bash（MSYS）の PID は、同じ Git for Windows の bash どうしなら、
# 別のプロセスの木からも kill -0 で見える。taskkill /F で落とすと失敗に変わる（2026-10-31 に確かめた）。
# kill -0 が権限で断られただけ（別の利用者のプロセス）のときは、/proc に残っていれば生きている扱いにする。
owner_alive() {
  kill -0 "$1" 2>/dev/null && return 0
  [ -d /proc/self ] && [ -e "/proc/$1" ]
}

# 持ち主のプロセスが居なくなった古い鍵を外す。外したら 0、外さないときは 1 を返す。
# 外すのは mkdir で取れなかったときだけ。外したあとは、呼ぶ側がもう一度 mkdir で取りに行く（取れるのは1つだけ）。
# 2つの待ち手が同時に外しに来ても、who を自分だけの名前へ移せる（rename が通る）のは1つ。移したあとに中身を見直し、
# 見ていた古い鍵でなければ（ほかの待ち手が外して取り直した、新しい持ち主の who なら）元へ戻して外さない。
break_stale() {
  local first pid at age moved
  first="$(head -n 1 "$L/who" 2>/dev/null | cut -d' ' -f1)"
  # who が無い・書きかけ・形が違う（PID-乱数-取った時刻 でない）ときは、持ち主が分からないので外さない
  [[ "$first" =~ ^([0-9]+)-[0-9]+-([0-9]+)$ ]] || return 1
  pid="${BASH_REMATCH[1]}"
  at="${BASH_REMATCH[2]}"
  owner_alive "$pid" && return 1
  age=$(($(date +%s) - at))
  [ "$age" -ge "$stale_after" ] || return 1
  moved="$L/who.stale.$me"
  mv "$L/who" "$moved" 2>/dev/null || return 1
  if [ "$(head -n 1 "$moved" 2>/dev/null | cut -d' ' -f1)" != "$first" ]; then
    mv "$moved" "$L/who" 2>/dev/null
    return 1
  fi
  echo "heavy.sh: 鍵の持ち主のプロセス（PID $pid）が居ない。鍵を取ってから ${age} 秒たっているので、古い鍵として外して取り直す（$L）。持っていたもの：$(head -n 1 "$moved" | cut -d' ' -f2-)" >&2
  rm -f "$moved"
  rmdir "$L" 2>/dev/null
  return 0
}

waited=0
until mkdir "$L" 2>/dev/null; do
  break_stale && continue
  sleep "$poll"
  waited=$((waited + poll))
  if [ "$waited" -ge "$wait_max" ]; then
    echo "heavy.sh: $((wait_max / 60)) 分待っても鍵が空かない（$L）。持っているもの：" >&2
    cat "$L/who" >&2 2>/dev/null
    echo "動いていないなら、持ち主か頭役が見て外す。" >&2
    exit 99
  fi
done
# 持ち主の印：PID・乱数・鍵を取った時刻（秒）。待つ側は、ここから持ち主の生死と鍵の古さを読む
token="$me-$(date +%s)"
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
