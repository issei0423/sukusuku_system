#!/usr/bin/env bash
# CI（.github/workflows/ci.yml）のジョブと同じ確かめを、worktree の上で1つずつ回す。
# GitHub Actions が課金で動かないあいだ、マージの前の確かめの代わりにする（2026-10-21〜）。
# 重いので、heavy.sh の鍵を通して呼ぶ：bash heavy.sh bash local-ci.sh <worktree> <ログの置き場>
#
# 結果は <ログの置き場>/result.txt に1行ずつ（head=<sha>、<名前>=ok|FAIL…）。最後まで回ったら done=yes。
# 途中で止まった（done=yes が無い）結果は、通ったことにしない（src/shell.ts の parseCiResult）。
set -u
wt="$1"; out="$2"; mkdir -p "$out"
res="$out/result.txt"; : > "$res"

# サーバの AI の下書き（server/main.go）が本物の API を呼ばないように、キーを渡さない
unset ANTHROPIC_API_KEY

step() { # step <名前> <ディレクトリ> <コマンド…>
  local name="$1" dir="$2"; shift 2
  if (cd "$dir" && "$@") > "$out/$name.log" 2>&1; then echo "$name=ok" >> "$res"; else echo "$name=FAIL" >> "$res"; fi
}

# 空いているポートを1つ取る（固定のポートだと、ほかの worktree の CI やサーバとぶつかる）
free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"
}

echo "head=$(git -C "$wt" rev-parse HEAD)" >> "$res"

# server
step go-vet  "$wt/server" go vet ./...
step go-test "$wt/server" go test -count=1 ./...

# web
step npm-ci           "$wt/web" npm ci
step build            "$wt/web" npm run build
step responsive-check "$wt/web" npm run review:responsive:check
step security-check   "$wt/web" npm run review:security:check
step lint             "$wt/web" npm run lint
step vitest           "$wt/web" npm test

# 結合（Go サーバを使い捨ての DB で立て、http.ts から叩く）
tmp="$out/integ"; rm -rf "$tmp"; mkdir -p "$tmp/no-web"
port="$(free_port)"
echo "integration-port: $port" > "$out/integ-port.txt"
if (cd "$wt/server" && go build -o "$tmp/sukusuku-server.exe" .) > "$out/integ-build.log" 2>&1; then
  # -files を渡さないと、連絡帳の写真（結合テストが上げる）が、呼んだときのフォルダの files/ に残る
  "$tmp/sukusuku-server.exe" -addr "127.0.0.1:$port" -db "$tmp/ci.db" -web "$tmp/no-web" -files "$tmp/files" > "$out/integ-server.log" 2>&1 &
  spid=$!
  up=0; for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/api/me" && { up=1; break; }; sleep 1; done
  if [ $up = 1 ]; then
    if (cd "$wt/web" && SUKUSUKU_API="http://127.0.0.1:$port" npm run test:integration) > "$out/integration.log" 2>&1; then echo "integration=ok" >> "$res"; else echo "integration=FAIL" >> "$res"; fi
  else echo "integration=FAIL(server did not start)" >> "$res"; fi
  kill $spid 2>/dev/null; wait $spid 2>/dev/null
else echo "integration=FAIL(build)" >> "$res"; fi

# security（ハーネスが自分でサーバを立てる。ポートは SECURITY_PORT で渡す。web/playwright.security.config.ts）
export SECURITY_PORT; SECURITY_PORT="$(free_port)"
step security "$wt/web" npm run review:security

# a11y（Playwright。メモリのため workers=1）
step a11y "$wt/web" npm run test:a11y -- --workers=1

echo "done=yes" >> "$res"
cat "$res"
