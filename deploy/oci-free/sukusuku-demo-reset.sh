#!/usr/bin/env bash
# デモの公開先の DB を、いまのデモデータで作り直す。VM の systemd の timer（sukusuku-demo-reset.timer）が毎晩 root で呼ぶ。
#
# わけ（2026-10-29）：デモデータは DB を初めて作ったときに1回だけ入る。反映でコードが新しくなっても DB は残るので、
# 公開先は古いデモの名前（チームの人の名前。#282 で変えた）と、DB を作った日の日付のままだった。
# 毎晩作り直すと、デモはいつも今日の日付と、いまの本線のデモデータになる。試しに入れたデータも消える。
#
# していること
#   1. 反映（sukusuku-deploy.sh）と同じ鍵を取り、反映と重ならないようにする
#   2. サービスを止め、DB（と -wal・-shm・-journal）と写しのファイル（files/）を、
#      /var/backups/sukusuku/demo-reset-<UTC の日時>/ へ移す（消さない）
#   3. サービスを起動する。サーバは DB が無ければ、いまのデモデータで作り直す（server/db.go の openDB）
#   4. 応答を確かめる。返らなければ、前の DB を戻して起動し直し、失敗で終わる
#   5. 作り直しの退避を新しい順に 7 世代だけ残し、それより古いものを消す【仮置き】
#
# 手元で確かめるときは sukusuku-demo-reset.test.sh を回す（パスとコマンドを環境変数で差し替える）。
set -euo pipefail

state=${SUKUSUKU_STATE_DIR:-/var/lib/sukusuku}
backups=${SUKUSUKU_BACKUP_DIR:-/var/backups/sukusuku}
keep=${SUKUSUKU_RESET_KEEP:-7}
lockfile=${SUKUSUKU_LOCK:-/run/lock/sukusuku-deploy.lock}
systemctl_cmd=${SYSTEMCTL:-systemctl}
flock_cmd=${FLOCK:-flock}
mv_cmd=${SUKUSUKU_MV:-mv}
health_cmd=${SUKUSUKU_HEALTH_CMD:-curl --fail --silent --max-time 2 --output /dev/null http://127.0.0.1:8080/api/terms}
tries=${SUKUSUKU_HEALTH_TRIES:-120}
wait_sec=${SUKUSUKU_HEALTH_WAIT:-1}

if [[ ${SUKUSUKU_TEST_NON_ROOT:-} != 1 && ${EUID} -ne 0 ]]; then
  echo 'root で実行してください。' >&2
  exit 2
fi
if [[ ! $keep =~ ^[1-9][0-9]*$ ]]; then
  echo "残す世代の数が正しくありません: $keep" >&2
  exit 2
fi

# 反映と同じ鍵。反映が進んでいれば、終わるまで最大 15 分待つ
exec 9>"$lockfile"
"$flock_cmd" -w 900 9 || { echo '反映が終わらないため、作り直しをやめました。' >&2; exit 1; }

db="$state/sukusuku.db"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$backups/demo-reset-$stamp"
# 退避は root だけが読める（0700）。手元のテスト（Windows の一時フォルダ）では権限を変えられないので作るだけにする
if [[ ${SUKUSUKU_TEST_NON_ROOT:-} == 1 ]]; then
  mkdir -p "$backups" "$dest"
else
  install -d -m 0700 "$backups"
  mkdir -m 0700 "$dest"
fi

healthy() {
  local i
  for ((i = 0; i < tries; i++)); do
    if "$systemctl_cmd" is-active --quiet sukusuku && $health_cmd; then
      return 0
    fi
    sleep "$wait_sec"
  done
  return 1
}

"$systemctl_cmd" stop sukusuku

# 移す途中で失敗したら（容量が足りないなど）、移したものを戻して起動し直す。
# set -e のまま止まると、サービスが止まったまま朝になるため（API の review の指摘、PR #320）
moved=()
put_back() {
  local name
  for name in "${moved[@]}"; do
    mv -- "$dest/$name" "$state/$name" || echo "戻せませんでした：$dest/$name" >&2
  done
}
trap 'echo "退避の途中で失敗したので、移したものを戻して起動し直します。" >&2; put_back; "$systemctl_cmd" start sukusuku || true; exit 1' ERR
for name in sukusuku.db sukusuku.db-wal sukusuku.db-shm sukusuku.db-journal files; do
  if [[ -e $state/$name ]]; then
    $mv_cmd -- "$state/$name" "$dest/$name"
    moved+=("$name")
  fi
done
trap - ERR

"$systemctl_cmd" start sukusuku || true

if ! healthy; then
  echo '作り直した DB でサーバが応答しないため、前の DB に戻します。' >&2
  "$systemctl_cmd" stop sukusuku || true
  # ここで mv が失敗しても、最後の start まで必ず進む（止まったまま朝にしない）
  mkdir -p "$dest/failed-new" || true
  for name in sukusuku.db sukusuku.db-wal sukusuku.db-shm sukusuku.db-journal files; do
    if [[ -e $state/$name ]]; then
      mv -- "$state/$name" "$dest/failed-new/$name" || echo "よけられませんでした：$state/$name" >&2
    fi
  done
  put_back
  "$systemctl_cmd" start sukusuku || true
  exit 1
fi

# 作り直しの退避は新しい順に $keep 世代だけ残す（反映のときのバックアップ *.db には触らない）
mapfile -t olds < <(find "$backups" -mindepth 1 -maxdepth 1 -type d -name 'demo-reset-*' -printf '%f\n' | sort -r | tail -n +"$((keep + 1))")
for old in "${olds[@]}"; do
  rm -rf -- "${backups:?}/$old"
done

if [[ ! -e $db ]]; then
  echo "サーバは応答したが、DB のファイルがまだ見えません（$db）。" >&2
fi
echo "デモの DB を作り直しました。前の DB は $dest に移しました（${moved[*]:-なし}）。"
