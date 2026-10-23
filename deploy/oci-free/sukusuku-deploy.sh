#!/usr/bin/env bash
# GitHub Actions の専用 runner から、検査とビルドを終えた成果物を既存 VM に配置する。
set -euo pipefail

if [[ ${EUID} -ne 0 || $# -ne 2 ]]; then
  echo 'root で実行し、成果物のディレクトリと commit SHA を指定してください。' >&2
  exit 2
fi

source_dir=$(realpath -e -- "$1")
commit=$2
if [[ ! $commit =~ ^[0-9a-f]{40}$ ]] ||
   [[ ! -f $source_dir/sukusuku || ! -f $source_dir/web/index.html || ! -f $source_dir/commit ]] ||
   [[ $(cat "$source_dir/commit") != "$commit" ]]; then
  echo '成果物または commit SHA が正しくありません。' >&2
  exit 2
fi
if [[ -n $(find "$source_dir" -type l -print -quit) ]]; then
  echo 'シンボリックリンクを含む成果物は配置しません。' >&2
  exit 2
fi

exec 9>/run/lock/sukusuku-deploy.lock
flock -n 9 || { echo '別のデプロイが進行中です。' >&2; exit 1; }

base=/opt/sukusuku
release="$base/releases/$commit"
if [[ -e $release ]]; then
  if [[ -L $base/current && $(readlink "$base/current") == "releases/$commit" ]]; then
    echo "この commit はすでに稼働中です: $commit"
    exit 0
  fi
  echo '同じ commit の release が残っています。手作業で状態を確認してください。' >&2
  exit 1
fi
if [[ ! -L $base/current || ! -L $base/sukusuku || ! -L $base/web ]]; then
  echo '初回移行が済んでいません。README の手順で既存配置を release へ移してください。' >&2
  exit 1
fi

previous=$(readlink "$base/current")
staging=$(mktemp -d "$base/releases/.incoming.XXXXXXXX")
trap 'rm -rf -- "$staging"; rm -f -- "$base/current.next"' EXIT
install -m 0755 -o root -g root "$source_dir/sukusuku" "$staging/sukusuku"
install -d -m 0755 -o root -g root "$staging/web"
cp -a -- "$source_dir/web/." "$staging/web/"
chown -R root:root "$staging/web"
find "$staging/web" -type d -exec chmod 0755 {} +
find "$staging/web" -type f -exec chmod 0644 {} +
printf '%s\n' "$commit" > "$staging/commit"
chmod 0644 "$staging/commit"

# データベースは更新前にオンラインバックアップを取る。実データを入れる前にも別途バックアップ方針が必要。
db=/var/lib/sukusuku/sukusuku.db
if [[ -f $db ]]; then
  install -d -m 0700 -o root -g root /var/backups/sukusuku
  backup="/var/backups/sukusuku/$(date -u +%Y%m%dT%H%M%SZ)-$commit.db"
  python3 - "$db" "$backup" <<'PY'
import sqlite3
import sys

with sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True) as source:
    with sqlite3.connect(sys.argv[2]) as destination:
        source.backup(destination)
PY
  chmod 0600 "$backup"
fi

chmod 0755 "$staging"
mv -- "$staging" "$release"
ln -s "releases/$commit" "$base/current.next"
mv -Tf -- "$base/current.next" "$base/current"
systemctl restart sukusuku || true

for _ in {1..30}; do
  if systemctl is-active --quiet sukusuku &&
     curl --fail --show-error --silent --max-time 2 --output /dev/null http://127.0.0.1:8080/; then
    echo "デプロイ完了: $commit"
    exit 0
  fi
  sleep 1
done

echo '新しいアプリが応答しないため、前の実行ファイルと画面へ戻します。' >&2
ln -s "$previous" "$base/current.next"
mv -Tf -- "$base/current.next" "$base/current"
systemctl restart sukusuku
exit 1
