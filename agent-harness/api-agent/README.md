# api-agent：Issue を直して PR にし、PR を確かめてマージするエージェント

Anthropic の API（API キーで払う）の **`claude-sonnet-5-5`** で動くエージェント。この PC で動かす。仕事は2つ。

- **issues**：開いている Issue を古い順に1件ずつ、worktree を作って直させ、PR にする（マージはしない）
- **merge**：開いている PR を古い順に、本線を取り込み、手元の CI で確かめて、merge commit でマージする

ここまで Claude Code の頭役が手でしていた手順を、コードとエージェントに分けて移した。**決まった手順はコード、判断だけモデル。**

| する人 | すること |
| :-- | :-- |
| コード（`src/`） | Issue・PR の一覧と並べ方、worktree を作る、本線の取り込み、手元の CI、push、`gh pr merge --merge --match-head-commit`、コメント、記録 |
| モデル（1件・1つの判断ごとに新しい `query()`） | Issue の直しと PR を出すこと、ぶつかりの解き方、CI の落ちの見立てと直し |

作り：[Claude Agent SDK（TypeScript）](https://code.claude.com/docs/en/agent-sdk/overview) の `query()`。組み込みの Read・Write・Edit・Glob・Grep・Bash だけを渡す（サブエージェント・Web・MCP は渡さない）。

## 準備（持ち主・使う人が自分でする）

1. **API キーを作る**：[Claude Console](https://platform.claude.com/) の API Keys でキーを作る。支払いの上限（Spend limits）も Console で置いておくと安心
2. **キーを置く**：PowerShell で次を打ち、ターミナルを開き直す。**キーは自分で置く**（Claude に貼らない・どこにも書き写さない）

   ```powershell
   setx ANTHROPIC_API_KEY "<作ったキー>"
   ```

3. **依存を入れる**（Node.js 22 以上。このフォルダの中で）

   ```powershell
   cd agent-harness\api-agent
   npm ci
   ```

4. `gh auth status` で GitHub にログインしていることを確かめる（エージェントも `gh` を使う）
5. Git Bash があること（Windows。手元の CI と Bash の道具が使う）

## 使い方

```powershell
cd agent-harness\api-agent
npm run agent -- merge --dry-run          # まずこれ。API は呼ばず GitHub を読むだけ。選んだ PR・並び・頼みの文を出す
npm run agent -- issues --dry-run
npm run agent -- issues --issue 123 --max-usd 3   # 最初は1件だけで試す
npm run agent -- merge --pr 45
npm run agent -- all                      # issues のあと merge
```

| オプション | 意味 |
| :-- | :-- |
| `--issue N` / `--pr N` | その1件だけ |
| `--max-usd X` | 1回の実行の上限（米ドル）。既定 **$10【仮置き】** |
| `--per-item-usd Y` | 1件の上限（米ドル）。既定 **$3【仮置き】** |
| `--effort E` | `low`・`medium`・`high`・`xhigh`・`max`。既定 **medium**（Sonnet 5.5 のエージェントのコーディングは medium から始めるのが推し） |
| `--trust-gh-checks` | PR の GitHub の CI が全部 success で、取り込みも直しも要らないときは、手元の CI を省く（既定は省かない） |
| `--dry-run` | API を呼ばず、GitHub は読むだけ。worktree も作らない |

`ANTHROPIC_API_KEY` が無いと、`--dry-run` でないコマンドはエラーの文を出して止まる（終了コード 3）。Claude Code の契約のログインでは動かさない。

## 流れ

### issues

1. 開いている Issue を古い順に並べる。飛ばす：ラベル `agent-skip`・`tracking`、開いている PR が `Closes #n`・`Fixes #n` で指しているもの（同じ Issue に PR を重ねない）
2. 1件ごとに、本線から worktree を作る：`<worktree の根>/agent-issue-<n>`、ブランチ `agent/issue-<n>`
   - 根は環境変数 `SUKUSUKU_AGENT_WORKTREES`。既定はメインの作業ツリーの隣の `sukusuku-worktrees`
   - 前の実行の worktree やブランチが残っていたら、その Issue は飛ばす（消すのは持ち主）
3. エージェントに `prompts/issue.md` を渡す：本線で直っていれば根拠を書いて閉じる。直っていなければ直し（Go とモックの両方・両方にテスト・【仮置き】）、手元の CI を通し、日本語で commit、push、PR（`Closes #n`、節：何を・なぜ／決めたこと／人の判断を待つ／確かめたこと／確かめていないこと）。決めきれなければ下書きの PR で止まる。**マージはしない**
4. 結果（PR・閉じた・止めた・費用）は、コードが GitHub を見て決める

### merge

1. 開いている PR を古い順に並べる。飛ばす：下書き、題に「（マージしない）」、ラベル `agent-skip`・`do-not-merge`、フォーク。積み重ね（base が本線でない）は、土台の PR がマージ済みなら `gh pr edit --base mockup-go-react` で向け直して扱い、まだなら飛ばす。同じ Issue を閉じる PR が2本あれば、記録に書く（閉じない）
2. PR ごとに worktree（`agent-pr-<n>`、PR のブランチの先を切り離した HEAD で）を開き、`git merge --no-ff origin/mockup-go-react` で本線を取り込む。ぶつかったらエージェント（`prompts/merge-conflict.md`）が両方の意図を残して解く。解けなければ `git merge --abort` して次へ
3. 手元の CI を鍵を通して回す。落ちたらエージェント（`prompts/ci-failure.md`）が見立てる：PR と関わらない時々落ちるテストなら1回だけ回し直す、PR の落ちなら直して回し直す、だめなら記録して次へ
4. 取り込みや直しで commit が増えたら push する（force しない）
5. マージの直前に fetch し、本線が進んでいたら 2 からやり直す（2回まで）
6. `gh pr merge <n> --merge --match-head-commit <sha>` で押し、手元の CI の結果をコメントする。squash・rebase・`--admin`・`--delete-branch` は使わない。ブランチは消さない
7. 土台が入って扱えるようになった積み重ねの PR は、同じ実行の中でもう一周して拾う（3周まで）

## 費用の見込み

- `claude-sonnet-5-5` は **入力 $2・出力 $10／100万トークン**（キャッシュの読み出しは $0.20／100万トークン）
- 1件の目安（**推測**。まだ本物のキーで回していない）：Issue の直し 1件 $1〜3、ぶつかりの解き 1回 $0.2〜1、CI の落ちの見立て 1回 $0.3〜1.5。ぶつかりも CI の落ちも無い PR のマージは $0（モデルを呼ばない）
- 上限は2つ：1件ごと（`--per-item-usd`）と1回の実行（`--max-usd`）。SDK の `maxBudgetUsd` を1回の `query()` ごとに渡し、結果の `total_cost_usd` を足していって、残りが無ければ次の件へ進まない。`total_cost_usd` は SDK の見積もりで、上限を少し越えることがある。本当の請求は Console の Usage で見る
- 既定の $10・$3 は【仮置き】。持ち主が決めたら `src/config.ts` の `DEFAULT_MAX_USD`・`DEFAULT_PER_ITEM_USD` を直す

## 守り・止まるとき

エージェントが道具を使う前に、PreToolUse のフック（`src/safety.ts`、規則はここだけ。表のテストは `test/safety.test.ts`）が次を断る。断ったわけはモデルへ返り、記録の「守りで断った道具の呼び出し」に残る。

- `git push` の `--force`・`-f`・`--force-with-lease`・`+refspec`、本線（mockup-go-react・mockup・docs）への直接の push、push でブランチを消すこと。マージの流れでは push そのもの（push はコードがする）
- `git rebase`・`git pull --rebase`・`git reset --hard`（`git reset --hard origin/<いまのブランチ>` だけは許す）
- `git branch -d/-D`・`git push --delete`・`git worktree remove/prune`・タグや ref の削除、`rm -rf` など（worktree とログの置き場の中は許す。worktree そのもの・`.git` は不可）
- `gh pr merge`（マージはコードだけ）、`gh pr close`、「マージ」のラベルの付け外し、`gh repo delete/edit`・`gh issue delete`、`gh api` の書き込み（GET と mutation の無い graphql だけ許す）、`gh auth token`・`gh secret`・`gh workflow run`
- 秘密を出すもの：`printenv`・`env`・`set`・`export -p`・`$…KEY`・`$…TOKEN`・`process.env` をまるごと・`.env` を読む・`git credential`
- 持ち主のメインの作業ツリー・`~/.claude`・gh の設定を指すパス、作業用の worktree の外への Edit・Write、worktree とログの置き場・一時フォルダの外への書き込み（リダイレクト・tee・cp・mv）
- Web・サブエージェント・MCP の道具

ほかの守り：

- **認証は `ANTHROPIC_API_KEY` だけ。** API キーより先に効く `ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN`・クラウドの指定・`ANTHROPIC_BASE_URL` は、エージェントに渡す env から外す。設定の置き場（`CLAUDE_CONFIG_DIR`）は `~/.sukusuku-api-agent/claude-config` にして、持ち主の `~/.claude` の契約のログイン・フック・プラグイン・メモリを読まない。始まりのメッセージの `apiKeySource` が `ANTHROPIC_API_KEY` でなければ止める
- **リポジトリの外の設定を読まない。** `settingSources` は `[]`（`'project'` だと cwd の上のフォルダの CLAUDE.md・`.claude/rules` まで読むため）。リポジトリの `AGENTS.md`・`CLAUDE.md` は、システムプロンプトの後ろに付けて渡す
- 記録には秘密を書かない（キー・トークンらしい文字と、環境変数の秘密の値を伏せる）
- 手元の CI には `ANTHROPIC_API_KEY` を渡さない（サーバの AI の下書きが本物の API を呼ばないように）
- 止まるとき：上限に届いた、ぶつかりを解けない、CI が直らない、本線が進み続ける、push や `gh pr merge` が通らない、前の実行の worktree に変更が残っている。どれも記録に書いて次の件へ進む

## 手元の CI と鍵（`scripts/`）

- `local-ci.sh <worktree> <ログの置き場>`：CI のジョブと同じ確かめ（go vet・go test・npm ci・build・responsive／security の型検査・lint・vitest・結合・security・a11y）。結合と security のサーバは空いているポートで立てる。最後まで回ったら `result.txt` に `done=yes`
- `heavy.sh <コマンド…>`：重いコマンドを PC の中で1つずつ回す鍵。置き場は OS の一時フォルダの `sukusuku-heavy.lock`（環境変数 `SUKUSUKU_HEAVY_LOCK` で変えられる）。Claude Code の係・頭役も同じ鍵を使える。自分が取った鍵だけを外す

## 定時に回す（Windows のタスク スケジューラー）

例：毎晩 2:00 に `all` を $10 の上限で回す。`setx` のあとに作ったタスクは `ANTHROPIC_API_KEY` を読める。

```powershell
schtasks /Create /SC DAILY /ST 02:00 /TN "sukusuku-api-agent" /TR "cmd /c cd /d C:\Users\calif\sukusuku_system\agent-harness\api-agent && npm run agent -- all --max-usd 10 >> runs\scheduler.log 2>&1"
```

- 止めるときは `schtasks /Change /TN "sukusuku-api-agent" /DISABLE`
- 最初の何回かは手で回して、記録を見てから定時にする

## 記録の場所

`agent-harness/api-agent/runs/`（Git に入れない）

- `<日時>-<コマンド>.md`：要約（選んだもの・結果・PR・費用・止まったわけ・断った道具の呼び出し）。終わりに同じものを画面にも出す
- `<日時>-<コマンド>.jsonl`：メッセージの流れ（1行1つ。キーは伏せる）
- `<日時>-<コマンド>/`：手元の CI のログ（`ci-…/<名前>.log`）、PR の本文の下書き、エラーの出力

## できないこと・気をつけること

- **モデルを呼ぶところは、作った時点では本物のキーで回していない。** 偽のキーで、認証が API キーになること（`apiKeySource=ANTHROPIC_API_KEY`）、モデル・道具・モードの指定が届くこと、キーが違えば契約のログインへ落ちずに止まることまでを確かめた
- 守りはコマンドの文字を読む。ファイルに書いたスクリプトを実行したときの中身までは見ない。完全な砂場ではないので、上限と記録を見ながら使う
- 手元の CI は `.github/workflows/ci.yml` を写したもの。CI のジョブが変わったら `scripts/local-ci.sh` も直す
- 前の実行の worktree（`agent-issue-<n>`・変更の残った `agent-pr-<n>`）は消さない。残っていると、その件は飛ばす
- 積み重ねの PR の土台が同じ実行の中で入らなければ、次の実行で拾う
- 1つの PC で1つずつ回す前提（同じ件を2つの実行が同時に扱うことは考えていない）

## 仮置きの値

| 項目 | 仮置きの値 | 置いた場所 |
| :-- | :-- | :-- |
| 1回の実行の上限 | $10 | `src/config.ts` `DEFAULT_MAX_USD` |
| 1件の上限 | $3 | `src/config.ts` `DEFAULT_PER_ITEM_USD` |
| モデルを呼ぶ最小の残り | $0.05 | `src/config.ts` `MIN_CALL_USD` |
| 1回の query() の往復の上限 | Issue 200・ぶつかり 80・CI 120 | `src/config.ts` `MAX_TURNS` |
| 1回の query() の時間の上限 | Issue 120 分・ぶつかり 45 分・CI 90 分 | `src/config.ts` `QUERY_TIMEOUT_MIN` |
| 手元の CI 1回の時間の上限 | 120 分（鍵の待ちを含む） | `src/config.ts` `LOCAL_CI_TIMEOUT_MIN` |

## 開発

```powershell
npm run typecheck   # tsc --noEmit
npm test            # 守りの表・引数・選び方・上限・CI の結果の読み取り・頼みの文
```

SDK の版は `package.json` で固定している（`@anthropic-ai/claude-agent-sdk` 0.3.296）。上げるときは、[TypeScript の参照](https://code.claude.com/docs/en/agent-sdk/typescript) の options（`settingSources`・`permissionMode`・`hooks`・`env`）と認証の順が変わっていないかを見る。
