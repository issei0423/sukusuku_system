// 重いコマンドの鍵（scripts/heavy.sh）：持ち主のプロセスが居なくなった古い鍵を、待つ側が外して取り直す（2026-10-31）
// 鍵の置き場は、場合ごとに一時フォルダの中へ作る（SUKUSUKU_HEAVY_LOCK）。いま使われている本物の鍵には触らない。
// PID は Git Bash（MSYS）の PID なので、持ち主を立てる・落とす・見るは、全部 bash の台本の中でする。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { SCRIPTS_DIR } from '../src/config.ts';
import { resolveBash, slash } from '../src/shell.ts';

const HEAVY = slash(path.join(SCRIPTS_DIR, 'heavy.sh'));
const BASH = resolveBash();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** 台本の頭：$1 が heavy.sh、$2 が鍵の置き場、$3 が書き物の置き場。本物の鍵を使いそうなら止める */
const PRELUDE = `set -u
heavy="$1"; L="$2"; d="$3"
[ "\${SUKUSUKU_HEAVY_LOCK:-}" = "$L" ] || { echo "鍵の置き場が別になっていない" >&2; exit 2; }
# 持ち主が who を書くまで待つ（5秒まで）
wait_who() { for _ in $(seq 50); do [ -s "$L/who" ] && return 0; sleep 0.1; done; echo "who が書かれない" >&2; exit 3; }
# 書き物の置き場に stop ができるまで動き続ける、持ち主のコマンド。「hold &」の $! が heavy.sh の bash の PID になるように exec する
hold() { exec bash "$heavy" bash -c 'until [ -e "$0" ]; do sleep 0.2; done' "$d/stop" >/dev/null 2>&1; }
`;

let count = 0;
function scenario(body: string, env: Record<string, string>) {
  const dir = path.join(root, `case-${++count}`);
  fs.mkdirSync(dir);
  const lock = path.join(dir, 'lock');
  const file = path.join(dir, 'case.sh');
  fs.writeFileSync(file, PRELUDE + body);
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SUKUSUKU_HEAVY_')));
  const r = spawnSync(BASH, [slash(file), HEAVY, slash(lock), slash(dir)], {
    encoding: 'utf8',
    env: { ...base, SUKUSUKU_HEAVY_LOCK: slash(lock), ...env },
    timeout: 120_000,
    windowsHide: true,
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', lock, dir };
}

const BROKE = '古い鍵として外して取り直す';
const LONG = { timeout: 150_000 };

describe('heavy.sh：持ち主が居なくなった鍵', () => {
  it('持ち主のプロセスが落ちて（trap が走らずに）残った鍵は、待つ側が外して取る', LONG, () => {
    const r = scenario(
      `hold & owner=$!
wait_who
kill -9 "$owner"; wait "$owner" 2>/dev/null
[ -s "$L/who" ] && echo "left=yes"
echo "owner=$owner"
bash "$heavy" bash -c 'echo ran'
echo "code=$?"
[ -e "$L" ] && echo "after=held" || echo "after=free"
touch "$d/stop"
`,
      { SUKUSUKU_HEAVY_STALE: '0', SUKUSUKU_HEAVY_POLL: '1', SUKUSUKU_HEAVY_WAIT: '20' },
    );
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^left=yes$/m, 'kill -9 では trap が走らず、鍵が残る（この場合の前提）');
    assert.match(r.out, /^ran$/m, r.err);
    assert.match(r.out, /^code=0$/m, r.err);
    assert.match(r.out, /^after=free$/m, '取り直した鍵も、終われば外れる');
    const owner = /^owner=(\d+)$/m.exec(r.out)?.[1];
    assert.ok(owner);
    assert.ok(r.err.includes(`（PID ${owner}）が居ない`), `誰の鍵を、なぜ外したかを stderr に出す：${r.err}`);
    assert.equal(r.err.split(BROKE).length - 1, 1, r.err);
  });

  it('持ち主が生きている鍵は、どれだけ長く持っていても外さない（待つ上限で 99）', LONG, () => {
    const r = scenario(
      `hold & owner=$!
wait_who
before="$(head -n 1 "$L/who")"
bash "$heavy" bash -c 'echo ran'
echo "code=$?"
[ "$(head -n 1 "$L/who" 2>/dev/null)" = "$before" ] && echo "who=same"
touch "$d/stop"; wait "$owner"; echo "owner_code=$?"
[ -e "$L" ] && echo "after=held" || echo "after=free"
`,
      { SUKUSUKU_HEAVY_STALE: '0', SUKUSUKU_HEAVY_POLL: '1', SUKUSUKU_HEAVY_WAIT: '2' },
    );
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^code=99$/m, r.err);
    assert.doesNotMatch(r.out, /^ran$/m);
    assert.match(r.out, /^who=same$/m, '生きている持ち主の who に手を付けない');
    assert.match(r.out, /^owner_code=0$/m);
    assert.match(r.out, /^after=free$/m, '持ち主は自分の鍵を自分で外せる');
    assert.ok(!r.err.includes(BROKE), r.err);
  });

  it('鍵を取ってから猶予（SUKUSUKU_HEAVY_STALE）がたっていない鍵は、持ち主が居なくても外さない', LONG, () => {
    const r = scenario(
      `bash -c 'exit 0' & dead=$!; wait "$dead"
mkdir "$L"
printf '%s %s %s\\n' "$dead-1-$(date +%s)" "00:00" "npm test" > "$L/who"
before="$(cat "$L/who")"
bash "$heavy" bash -c 'echo ran'
echo "code=$?"
[ "$(cat "$L/who" 2>/dev/null)" = "$before" ] && echo "who=same"
`,
      { SUKUSUKU_HEAVY_STALE: '120', SUKUSUKU_HEAVY_POLL: '1', SUKUSUKU_HEAVY_WAIT: '2' },
    );
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^code=99$/m, r.err);
    assert.doesNotMatch(r.out, /^ran$/m);
    assert.match(r.out, /^who=same$/m);
  });

  it('3つの待ち手が同時に古い鍵を外しに来ても、外すのは1つで、鍵を持つのは1つずつ', LONG, () => {
    // 持ち主が居ない（落ちた bash の PID）、10分前に取った鍵を作る。猶予は既定（120秒）のまま
    const r = scenario(
      `bash -c 'exit 0' & dead=$!; wait "$dead"
mkdir "$L"
printf '%s %s %s\\n' "$dead-1-$(( $(date +%s) - 600 ))" "00:00" "npm test" > "$L/who"
pids=""
for i in 1 2 3; do
  bash "$heavy" bash -c 'echo "start $1" >> "$0"; sleep 1; echo "end $1" >> "$0"' "$d/log" "$i" 2> "$d/err-$i" &
  pids="$pids $!"
done
for p in $pids; do wait "$p"; echo "code=$?"; done
[ -e "$L" ] && echo "after=held" || echo "after=free"
`,
      { SUKUSUKU_HEAVY_POLL: '1', SUKUSUKU_HEAVY_WAIT: '30' },
    );
    assert.equal(r.status, 0, r.err);
    assert.equal((r.out.match(/^code=0$/gm) ?? []).length, 3, r.out);
    assert.match(r.out, /^after=free$/m);
    const lines = fs.readFileSync(path.join(r.dir, 'log'), 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 6, lines.join('\n'));
    for (let i = 0; i < lines.length; i += 2) {
      const [s, who1] = (lines[i] ?? '').split(' ');
      const [e, who2] = (lines[i + 1] ?? '').split(' ');
      assert.deepEqual([s, e, who1], ['start', 'end', who2], `重なって動いた：\n${lines.join('\n')}`);
    }
    assert.deepEqual(new Set(lines.map((l) => l.split(' ')[1])), new Set(['1', '2', '3']));
    const errs = [1, 2, 3].map((i) => fs.readFileSync(path.join(r.dir, `err-${i}`), 'utf8')).join('');
    assert.equal(errs.split(BROKE).length - 1, 1, `外すのは1つだけ：\n${errs}`);
  });
});
