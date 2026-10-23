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

### task（任意の頼みの文を走らせる）

Issue や PR と関係なく、頼みの文のファイルを 1 つ、API の Sonnet 5.5 に走らせる。全体テストの区画（チャット・日誌・管理など）を、Claude Code の枠を使わずに回すためのコマンド。

```powershell
npm run agent -- task --prompt-file D:\qa\chat.md --cwd C:\Users\me\sukusuku-worktrees\qa-chat `
  --allow-dir D:\qa\out --out D:\qa\out\chat-result.md --label 全体テスト-チャット --max-usd 5 --dry-run   # まず --dry-run
```

| オプション | 意味 |
| :-- | :-- |
| `--prompt-file F`（必須） | 頼みの文のファイル（UTF-8） |
| `--cwd DIR`（必須） | エージェントの作業フォルダ。守りの `workdir` になり、Edit・Write はここだけ。メインの作業ツリー・api-agent・`~/.claude` などの守りのフォルダの中（と、それを含む親）なら断って止まる |
| `--allow-dir DIR` | 書いてよいフォルダを足す（何回でも）。守りのフォルダと重なるなら断る |
| `--label 名前` | 記録の見出し。既定はファイル名 |
| `--out FILE` | エージェントの最後の文を、このファイルにも書く（ファイルを書けないときも結果が残る）。置き場は `--cwd` か `--allow-dir` の中だけ |
| `--max-turns N` / `--timeout-min M` | 往復の上限（既定 200）・時間の上限（既定 60 分）【仮置き】 |
| `--max-usd X` / `--per-item-usd Y` / `--effort E` | ほかのコマンドと同じ（既定 $10・$3・medium） |
| `--dry-run` | API を呼ばず、設定（cwd・allow-dir・out・上限）と頼みの文の頭 40 行を出す。記録は書かない |

- **push はしない**（`allowPush` は常に false）。マージ・force・削除・秘密の守りはそのまま効く
- 結果は記録（`runs/<日時>-task.md`）に 1 件として残る：費用・往復の数・成否（`subtype`）・止まったわけ・断った道具の呼び出し
- 費用の目安（**推測**。まだ本物のキーで回していない）：画面を開いて確かめる区画 1 つで $1〜5。上限の $3（1件）を越えそうな区画は `--per-item-usd` を上げるか、頼みの文を区画ごとに割る

### review（PR のレビュー）

**GitHub Actions が止まっている間の、PR を開いたときの自動のレビュー（`.github/workflows/claude-review.yml`）の代わり。** 開いている PR を読んで、API の Sonnet 5.5 にレビューさせ、コードが PR にコメントする。`all` には入らない（別に呼ぶ）。

```powershell
npm run agent -- review --dry-run                 # まずこれ。選んだ PR と、飛ばしたわけを出す（API も gh の書き込みもしない）
npm run agent -- review --pr 275 --max-usd 3      # 1件だけ試す
npm run agent -- review                           # 開いている PR を古い順に
npm run agent -- review --pr 275 --force          # 同じ先頭の commit でも見直す
```

| オプション | 意味 |
| :-- | :-- |
| `--pr N` | その PR だけ（下書きでも見る） |
| `--include-drafts` | 下書きの PR も見る |
| `--force` | 同じ先頭の commit をレビュー済みでも見直す |
| `--max-usd X` / `--per-item-usd Y` / `--effort E` / `--dry-run` | ほかのコマンドと同じ（既定 $10・$3・medium） |

1. **コードが PR を選ぶ**：開いている PR を古い順に並べる。飛ばす：フォーク、下書き（`--include-drafts`・`--pr N` なら見る）、ラベル `agent-skip`、**同じ先頭の commit をレビュー済みのもの**（`--force` で見直す）
   - レビュー済みの見分け方：PR のコメントに印 `<!-- api-agent-review head=<40桁の sha> -->` があるか。**数えるのは、いまの gh のアカウント（`gh api user --jq .login` で実行の初めに1回取る）が書いたコメントの印だけ**（他人は印を書けるので信じない）。アカウントが取れないときは印を信じず、どの PR も「レビューしていない」と見て、記録のメモに残す。PR に push があって先頭が変われば、また見る
2. PR ごとに worktree を作る：`<worktree の根>/agent-review-<n>`、PR の先頭の commit を切り離した HEAD で（根は merge と同じ。既にあれば、きれいなときだけ先頭に合わせて使い回す）
3. エージェントに `prompts/review.md` を渡す：`claude-review.yml` の4つの観点（バグ・動かなくなるところ／セキュリティ／読みやすさ／保育の現場で困る動き）と書き方（読んで確かめた指摘だけ・確かめられないものは「未確認」・問題がなければ短く）に、リポジトリの決まり（Go とモックの両方・【仮置き】と `web/仮置き値.md`）を足した。`.github/` を変える PR には、ワークフローの安全（きっかけ・権限・秘密・self-hosted runner）の観点を足す。差分は `git diff origin/<base>...HEAD`、本文は `gh pr view <n>` で読ませる。`.github/` を変えたかの判定（`git diff`）が失敗したときは、黙って外さずワークフローの観点を足し、PR の記録に「判定に失敗したので、ワークフローの観点を足した」と残す
4. **コードが** `gh pr comment <n> --body-file …` で、エージェントの最後の文を送る。送る前に秘密を伏せ、末尾に費用と先頭の sha の行と、上の印を付ける。レビューが済まなかったとき（上限・時間・往復・認証）は送らない
5. 結果は記録（`runs/<日時>-review.md`）に1件ずつ残る

- **エージェントは読むだけ**：`allowPush` は false。頼みの文で PR・Issue への書き込み（`gh pr comment`・`gh pr review`）も禁じている。守りのフック（`src/safety.ts`）も `allowGhWrite: false` では読むだけの gh の許可リストしか通さない（頼みの文と二重に止める。下の「守り・止まるとき」）。コメントの印はコードだけが付ける
- 費用の目安（**推測**。まだ本物のキーで回していない）：1件 $0.3〜2。差分が大きい PR や、`.github/` を変える PR は上の方。既定の上限は1件 $3・1回 $10。PR が多いときは `--max-usd` で止まり、残りは次の実行で拾う（印の無いものだけ見るので、同じ PR を二重に払わない）
- 定時に回す例（毎朝 8:00 と夜 20:00。Actions が止まっている間だけ）：

```powershell
schtasks /Create /SC DAILY /ST 08:00 /TN "sukusuku-api-agent-review-am" /TR "cmd /c cd /d C:\Users\calif\sukusuku_system\agent-harness\api-agent && npm run agent -- review --max-usd 5 >> runs\scheduler-review.log 2>&1"
schtasks /Create /SC DAILY /ST 20:00 /TN "sukusuku-api-agent-review-pm" /TR "cmd /c cd /d C:\Users\calif\sukusuku_system\agent-harness\api-agent && npm run agent -- review --max-usd 5 >> runs\scheduler-review.log 2>&1"
```

  止めるときは `schtasks /Change /TN "sukusuku-api-agent-review-am" /DISABLE`（pm も同じ）。Actions が直ったら、`claude-review.yml` と二重にならないように止める。

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
- **`allowGhWrite` の true・false によらず常に断る**：`gh alias`（別名で push を作ると、push を断る守りをすり抜けられる）・`gh extension`、`gh gist` の create・edit・delete・clone、`gh repo` の create・fork・sync・delete・rename・archive・unarchive・edit・set-default・clone、`gh pr update-branch`・`gh pr lock`・`gh pr unlock`、`gh issue develop`・`gh issue lock`・`gh issue unlock`
- **`allowGhWrite` が false の仕事**（review・task・merge のぶつかり／CI の見立て）では、**許可リスト**にある読むだけの gh しか通さない。リストの外は断る（`gh pr comment`・`gh issue create`・`gh label create`・`gh browse`・知らないサブコマンドも）。通すのは次だけ：`gh pr view|list|diff|checks|status`・`gh issue view|list|status`・`gh repo view`・`gh api` の GET・`gh auth status`・`gh label list`・`gh release view|list`・`gh run view|list`・`gh workflow view|list`・`gh search *`・`gh status`。true なのは issues の流れだけ（`gh pr create`・`gh issue close --comment`・`gh issue comment` などが要る）
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
