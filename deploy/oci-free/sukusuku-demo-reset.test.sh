#!/usr/bin/env bash
# sukusuku-demo-reset.sh を、一時フォルダと偽物の systemctl・flock で確かめる。VM ではなく手元で回す。
#   bash deploy/oci-free/sukusuku-demo-reset.test.sh
set -euo pipefail

script="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/sukusuku-demo-reset.sh"
passed=0
failed=0

ok() { passed=$((passed + 1)); printf '通過：%s\n' "$1"; }
ng() { failed=$((failed + 1)); printf '失敗：%s\n%s\n' "$1" "${2:-}"; }

# 偽物の systemctl：呼ばれた順を calls.log に書く。start で「サーバが新しい DB を作った」ことにする
make_fakes() {
  local root=$1
  mkdir -p "$root/bin"
  cat > "$root/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$root/calls.log"
case "\$1" in
  stop) rm -f "$root/active" ;;
  start) touch "$root/active"; [[ -e "$root/state/sukusuku.db" ]] || echo new > "$root/state/sukusuku.db" ;;
  is-active) [[ -e "$root/active" ]] ;;
esac
EOF
  chmod +x "$root/bin/systemctl"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$root/bin/flock"
  chmod +x "$root/bin/flock"
}

# run 一時フォルダ 応答（true/false） [変数=値 ...]
run() {
  local root=$1 health=$2
  shift 2
  env SUKUSUKU_TEST_NON_ROOT=1 SUKUSUKU_STATE_DIR="$root/state" SUKUSUKU_BACKUP_DIR="$root/backups" \
    SUKUSUKU_LOCK="$root/lock" SYSTEMCTL="$root/bin/systemctl" FLOCK="$root/bin/flock" \
    SUKUSUKU_HEALTH_CMD="$health" SUKUSUKU_HEALTH_TRIES=2 SUKUSUKU_HEALTH_WAIT=0 "$@" bash "$script"
}

new_root() {
  local root
  root=$(mktemp -d)
  mkdir -p "$root/state/files"
  echo old > "$root/state/sukusuku.db"
  echo wal > "$root/state/sukusuku.db-wal"
  echo photo > "$root/state/files/a.jpg"
  touch "$root/active"
  make_fakes "$root"
  echo "$root"
}

# 1. ふつうに作り直す：前の DB・-wal・files を退避へ移し、起動すると新しい DB ができる
r=$(new_root)
if out=$(run "$r" true 2>&1); then
  d=$(find "$r/backups" -mindepth 1 -maxdepth 1 -type d -name 'demo-reset-*' | head -1)
  if [[ -n $d && $(cat "$d/sukusuku.db") == old && -e $d/sukusuku.db-wal && -e $d/files/a.jpg &&
        $(cat "$r/state/sukusuku.db") == new && ! -e $r/state/files &&
        $(tr '\n' ' ' < "$r/calls.log") == 'stop sukusuku start sukusuku is-active --quiet sukusuku ' ]]; then
    ok '前の DB と files を退避へ移し、新しい DB で起動する'
  else
    ng '前の DB と files を退避へ移し、新しい DB で起動する' "$out / calls: $(cat "$r/calls.log")"
  fi
else
  ng '前の DB と files を退避へ移し、新しい DB で起動する（終了コードが 0 でない）' "$out"
fi
rm -rf "$r"

# 2. 作り直しの退避は 7 世代だけ残し、反映のバックアップ（*.db）には触らない
r=$(new_root)
mkdir -p "$r/backups"
for i in 1 2 3 4 5 6 7 8 9; do mkdir "$r/backups/demo-reset-2026010${i}T000000Z"; done
echo keep > "$r/backups/20260101T000000Z-abc.db"
if out=$(run "$r" true 2>&1); then
  n=$(find "$r/backups" -mindepth 1 -maxdepth 1 -type d -name 'demo-reset-*' | wc -l)
  if (( n == 7 )) && [[ -e $r/backups/20260101T000000Z-abc.db && ! -e $r/backups/demo-reset-20260101T000000Z &&
        ! -e $r/backups/demo-reset-20260103T000000Z && -e $r/backups/demo-reset-20260104T000000Z ]]; then
    ok '退避は新しい 7 世代だけ残し、反映のバックアップは消さない'
  else
    ng '退避は新しい 7 世代だけ残し、反映のバックアップは消さない' "残った数 $n: $(ls "$r/backups" | tr '\n' ' ')"
  fi
else
  ng '退避は新しい 7 世代だけ残す（終了コードが 0 でない）' "$out"
fi
rm -rf "$r"

# 3. 新しい DB で応答しなければ、前の DB に戻して失敗で終わる
r=$(new_root)
status=0
out=$(run "$r" false 2>&1) || status=$?
d=$(find "$r/backups" -mindepth 1 -maxdepth 1 -type d -name 'demo-reset-*' | head -1)
if (( status == 1 )) && [[ $(cat "$r/state/sukusuku.db") == old && -e $r/state/sukusuku.db-wal && -e $r/state/files/a.jpg &&
      $(cat "$d/failed-new/sukusuku.db") == new && -e $r/active && $out == *'前の DB に戻します'* ]]; then
  ok '応答しなければ前の DB に戻して起動し、終了コード 1'
else
  ng '応答しなければ前の DB に戻して起動し、終了コード 1' "終了コード $status: $out"
fi
rm -rf "$r"

# 4. root でなければ何もせずに止まる
r=$(new_root)
status=0
out=$(env SUKUSUKU_STATE_DIR="$r/state" SUKUSUKU_BACKUP_DIR="$r/backups" SYSTEMCTL="$r/bin/systemctl" FLOCK="$r/bin/flock" bash "$script" 2>&1) || status=$?
if [[ $EUID -eq 0 ]]; then
  ok 'root でなければ止まる（root で回したので見ない）'
elif (( status == 2 )) && [[ ! -e $r/calls.log && $(cat "$r/state/sukusuku.db") == old ]]; then
  ok 'root でなければ何もせずに止まる'
else
  ng 'root でなければ何もせずに止まる' "終了コード $status: $out"
fi
rm -rf "$r"

# 5. 残す世代の数が正しくなければ止まる
r=$(new_root)
status=0
out=$(run "$r" true SUKUSUKU_RESET_KEEP=0 2>&1) || status=$?
if (( status == 2 )) && [[ ! -e $r/calls.log ]]; then
  ok '残す世代の数が 0 なら何もせずに止まる'
else
  ng '残す世代の数が 0 なら何もせずに止まる' "終了コード $status: $out"
fi
rm -rf "$r"

# 6. 退避の途中で移せなかったら（files で失敗する偽物の mv）、移したものを戻して起動し、終了コード 1
r=$(new_root)
cat > "$r/bin/mv" <<'EOF'
#!/usr/bin/env bash
[[ $2 == */files ]] && { echo 'mv: 容量が足りません（偽物）' >&2; exit 1; }
exec mv "$@"
EOF
chmod +x "$r/bin/mv"
status=0
out=$(run "$r" true SUKUSUKU_MV="$r/bin/mv" 2>&1) || status=$?
if (( status == 1 )) && [[ $(cat "$r/state/sukusuku.db") == old && -e $r/state/sukusuku.db-wal && -e $r/state/files/a.jpg &&
      -e $r/active && $(tail -n 1 "$r/calls.log") == 'start sukusuku' && $out == *'移したものを戻して'* ]]; then
  ok '退避の途中で失敗したら、移したものを戻して起動し、終了コード 1'
else
  ng '退避の途中で失敗したら、移したものを戻して起動し、終了コード 1' "終了コード $status: $out / calls: $(cat "$r/calls.log" 2>/dev/null)"
fi
rm -rf "$r"

printf '通った %d 件、落ちた %d 件\n' "$passed" "$failed"
(( failed == 0 ))
