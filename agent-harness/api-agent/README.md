# api-agent：Issue を直して PR にし、PR を確かめてマージするエージェント

Anthropic の API（API キーで払う）の **`claude-sonnet-5-5`** で動くエージェント。この PC で動かす。おもな仕事は3つ。

- **queue**（マージ係の代わり）：持ち主が PR に付けたラベル「マージ」を、付けた順に1本ずつ、本線を取り込み、手元の CI で確かめて、merge commit で入れる。API キーが無くても、モデルを呼ばずに動く
- **issues**：ラベル「claude」の付いた Issue を古い順に1件ずつ、worktree を作って直させ、PR にする（マージはしない）
- **merge**：開いている PR を古い順に、本線を取り込み、手元の CI で確かめて、merge commit でマージする（ラベルを見ない、前からの流れ）

**merge・queue（と merge を含む all）は、リポジトリの持ち主（issei0423）の gh のアカウントでしか動かない**（`--dry-run` はだれでも動く）。review・issues・task は、だれのアカウントでも動く。

ここまで Claude Code の頭役が手でしていた手順を、コードとエージェントに分けて移した。**決まった手順はコード、判断だけモデル。**

| する人 | すること |
| :-- | :-- |
| コード（`src/`） | Issue・PR の一覧と並べ方、worktree を作る、本線の取り込み、手元の CI、push、`gh pr merge --merge --match-head-commit`、コメント、記録 |
| モデル（1件・1つの判断ごとに新しい `query()`） | Issue の直しと PR を出すこと、ぶつかりの解き方、CI の落ちの見立てと直し |

作り：[Claude Agent SDK（TypeScript）](https://code.claude.com/docs/en/agent-sdk/overview) の `query()`。組み込みの Read・Write・Edit・Glob・Grep・Bash だけを渡す（サブエージェント・Web・MCP は渡さない）。

## 準備（持ち主・使う人が自分でする）

1. **API キーを作る**：[Claude Console](https://platform.claude.com/) の API Keys でキーを作る。支払いの上限（Spend limits）も Console で置いておくと安心。queue だけを使うなら、キーは無くてよい（モデルを呼ばずに動く）
2. **キーを置く**：PowerShell で次を打ち、出てきた問いにキーを貼って Enter（画面には出ない）。**キーは自分で置く**（Claude に貼らない・どこにも書き写さない）

   ```powershell
   cd agent-harness\api-agent
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\set-key.ps1
   ```

   - キーは `~/.sukusuku-api-agent/anthropic-key.dpapi` に、**この Windows のユーザーだけが戻せる形（DPAPI、`ConvertFrom-SecureString`）**で置かれる。平文はどこにも書かない
   - 頭が `sk-ant-` でない・`sk-ant-` が2回ある（コピーの重ね）・途中に空白があるときは、書かずに止まる（終了コード 2）
   - 使うときは `scripts\agent.ps1` を通す。キーを戻して、**そのプロセスの中だけ**の `ANTHROPIC_API_KEY` にしてから `npm run agent` を回す
   - **`setx` でユーザー環境変数に置かない。** ユーザー環境変数に置くと、ターミナルの Claude Code が契約のログインよりそのキーを先に使い、「Invalid API key」で止まる（2026-10-24 に起きた）。前に `setx` で置いていたら、`[Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'User')` で消してターミナルを開き直す（set-key.ps1 も、残っていれば知らせる）

3. **依存を入れる**（Node.js 22 以上。このフォルダの中で）

   ```powershell
   cd agent-harness\api-agent
   npm ci
   ```

4. `gh auth status` で GitHub にログインしていることを確かめる（エージェントも `gh` を使う）
5. Git Bash があること（Windows。手元の CI と Bash の道具が使う）

## 使い方

キーを使うコマンドは `scripts\agent.ps1` から回す（キーをこのプロセスの中だけに戻す）。`--dry-run` やキーの要らない queue は、`npm run agent -- …` でも同じに動く。

```powershell
cd agent-harness\api-agent
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 queue --dry-run    # まずこれ。GitHub を読むだけ。拾う PR・並び・止める理由の見込みを出す
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 queue              # マージ係を1回まわす（持ち主のアカウントだけ）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 queue --no-model   # キーがあってもモデルを呼ばない
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 queue --recheck-main   # 本線の先頭が時々落ちるテストで赤になったとき、回し直す
npm run agent -- merge --dry-run          # API は呼ばず GitHub を読むだけ。選んだ PR・並び・頼みの文を出す
npm run agent -- issues --dry-run
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 issues --issue 123 --max-usd 3   # 最初は1件だけで試す
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 merge --pr 45
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\agent.ps1 all                # issues のあと merge
```

| オプション | 意味 |
| :-- | :-- |
| `--issue N` / `--pr N` | その1件だけ（`--issue N` は、ラベル「claude」が無くても扱う。queue には `--pr` は無い） |
| `--max-usd X` | 1回の実行の上限（米ドル）。既定 **$10【仮置き】** |
| `--per-item-usd Y` | 1件の上限（米ドル）。既定 **$3【仮置き】** |
| `--effort E` | `low`・`medium`・`high`・`xhigh`・`max`。既定 **medium**（Sonnet 5.5 のエージェントのコーディングは medium から始めるのが推し） |
| `--trust-gh-checks` | （merge・all）PR の GitHub の CI が全部 success で、取り込みも直しも要らないときは、手元の CI を省く（既定は省かない） |
| `--no-model` | （queue）API キーがあってもモデルを呼ばない。ぶつかり・CI の落ちは「マージ止め」にする |
| `--recheck-main` | （queue）本線の先頭の status があっても、始めに本線で手元の CI を回し直して付け直す（時々落ちるテストで赤になったときの抜け道） |
| `--dry-run` | API を呼ばず、GitHub は読むだけ。worktree も作らない。持ち主でないアカウントでも動く |

API キーが無いと、`--dry-run` でない issues・merge・all・review・task はエラーの文を出して止まる（終了コード 3）。Claude Code の契約のログインでは動かさない。queue はキーが無ければモデルを呼ばずに動く。

終了コード：0 済んだ・1 コードの失敗・2 引数が違う（set-key.ps1 ではキーの形が違う）・3 API キーが無い・**4 持ち主でないアカウントで merge・queue・all を回した**・130 Ctrl+C

### 持ち主だけが動かせるもの

merge・queue（と merge を含む all）は、始めに `gh api user --jq .login`（いまの gh のアカウント）と `gh repo view --json owner`（リポジトリの持ち主）を比べ、違えば日本語のわけを出して止まる（終了コード 4。大文字小文字は区別しない）。マージするかを決めるのは持ち主だけ（AGENTS.md「ブランチと PR」）なので、チームの人の PC でこのハーネスを回しても、マージやラベルの付け外しはしない。`--dry-run` は GitHub を読むだけなので、だれでも動く。

## 流れ

### queue（マージ係の代わり）

**GitHub の runner の Actions が課金で動かないあいだの、マージ係（`.github/workflows/merge.yml` ＋ `.github/scripts/merge-queue.sh`）の代わり。** 持ち主の操作は今までと同じで、入れたい PR にラベル「マージ」を付けるだけ。それを持ち主の PC で、定時か手で `agent.ps1 queue` を回して拾う。止める理由・コメントの文面・ラベルの扱いは merge-queue.sh に合わせた（`src/queue.ts`）。

1. **持ち主の確かめ**：いまの gh のアカウントが持ち主でなければ止まる（上の「持ち主だけが動かせるもの」）
2. **本線の先頭を見る**（PR を見る前）：本線の先頭の commit の status「手元の CI（持ち主の PC）」を読む
   - **無い・pending のまま**（または `--recheck-main`）なら、PR を見る前に、worktree `agent-main` で本線の先頭を開いて手元の CI を回し、status を付ける。赤なら Issue「本線の先頭で手元の CI が落ちた（<短い sha>）」を立てる（同じ題の開いた Issue があれば立てない。ラベルは付けない。`claude` を付けると自動実装の合図になるため）。回せなかった（worktree に変更が残っているなど）ときは、本線を確かめられないので列を止める
   - **failure（か error）**なら、**列を止める**（PR を1本も見ない。本線を直してから回す。merge-queue.sh の pick と同じ）。本線のせいで PR を「マージ止め」にしないため
   - **success** なら PR へ進む
3. **拾う**：開いている PR のうち、ラベル「マージ」の付いたもの。イベント（`repos/<owner>/<repo>/issues/<n>/events`）から、「マージ」の最後の labeled の actor と時刻を読む
   - actor が持ち主のものだけを、その時刻の順（同じなら番号の小さい順）に並べる
   - 持ち主でない人が最後に付けた「マージ」は、**外してコメントする**（merge-queue.sh の reject と同じ文面）
   - イベントを読めなかった PR は、外さずに次の実行で見直す
4. **止める**（「マージ」を外し「マージ止め」を付け、理由と直し方をコメント。列は次の PR へ進む）。前に分かるものは merge-queue.sh の順（フォーク → 下書き → base → `.github/` → レビュー）で見る
   - フォークからの PR・下書き・`.github/` を変える PR（名前を変えたファイルは元の名前も見る）・変更を求めるレビュー
   - ぶつかりを解けない・手元の CI が赤（下の 6）
   - 押す木（本線を取り込み、直したあとの形）が `.github/` を変えている（モデルがぶつかりや CI の直しでワークフローを変えたときの守り）
5. **待つ**（ラベルはそのまま、コメントもしない）：base が本線でない PR。土台の PR がマージ済みなら、merge と同じく `gh pr edit --base mockup-go-react` で向け直して扱う。同じ実行の中で土台が入れば、もう一周して拾う（3周まで）
6. **1本ごと**：merge の流れ（下の「merge」の 2〜6）をそのまま使う。worktree（`agent-pr-<n>`）で本線を取り込み、手元の CI を回し、増えた commit を push して、`gh pr merge <n> --merge --match-head-commit <sha>` で押す。squash・rebase・`--admin`・`--delete-branch` は使わない
   - **API キーがある**とき：ぶつかり・CI の落ちは、merge と同じくモデルに見立てさせる。解けない・直せないなら止める
   - **API キーが無い・`--no-model`** のとき：モデルを呼ばない。ぶつかったら取り込みをやめて止める。手元の CI が赤なら止める
   - 押す直前に PR を読み直し、手元の CI のあいだに「マージ」が外された・持ち主でない人が付け直した・下書きになった・変更を求めるレビューが付いた、なら入れない（merge-queue.sh の finish と同じ。ラベルは変えず、次の queue で扱う）
   - 上限・push の失敗・`gh pr merge` の失敗・本線が進み続けた・前の実行の worktree に変更が残っている、のときは、PR のせいとは限らないので**ラベルはそのまま**にし、記録に書いて次へ進む（次の queue で試し直す）
7. **押したあとの本線の先頭**：PR を押したら、新しい本線の先頭の木（tree）を、手元の CI で通した commit の木と比べる。同じなら、本線の先頭にも success を写す（重い CI を回し直さない。description は「通った・11 のジョブ（PR #n で回した abc1234 と同じ木）」）。違えば（ほかの commit が先に入ったなど）写さない
8. **終わりに本線の先頭を見る**：本線の先頭に status が無ければ（pending のままも含む。7 で写せなかったとき・ほかの人が入れたとき）、2 と同じく本線の先頭で手元の CI を回して付け、赤なら Issue を立てる

`--dry-run` では、GitHub を読むだけで、拾う PR・並び・外すラベル・止める理由とコメントの文面・入れる候補・終わりに本線で CI を回すかの見込みを出す（ラベル・コメント・status・Issue・worktree は作らない）。

### commit status（チームの人が PR の画面で結果を見る）

手元の CI のログは持ち主の PC にしか無いので、結果だけを commit status で GitHub に出す。**付けるのはコードだけ**（`src/status.ts`・`src/shell.ts` の `postCommitStatus`）。モデルには付けさせない（`src/safety.ts` が gh api の書き込みを断る）。queue と merge の両方で付ける。

- context は「**手元の CI（持ち主の PC）**」。回し始めに `pending`、終わりに `success` か `failure`。target_url は付けない
- description は 140 字以内。落ちたときは落ちたジョブの名前（例「結合 FAIL・a11y FAIL（本線 abc1234 と合わせた def5678）」）、通ったときは「通った・11 のジョブ（…）」
- 付ける commit は、手元の CI を回した commit（push する・押す木そのもの）。ただし本線を取り込んだ commit は push する前は GitHub に無く、status を付けられないので、そのあいだは PR の先頭（head）に付け、description に「未 push」と書く。通って push したら、push した commit にも success を付ける
- 本線の先頭の分は、queue の始め（status が無いとき・`--recheck-main`）と終わりに付け、押したあとは木が同じなら写す（上の 2・7・8）
- 付けられなかったとき（ネットや権限）は、記録に書いてマージの流れは続ける

### issues

1. 開いている Issue のうち、**ラベル「claude」の付いたもの**だけを古い順に並べる（`.github/workflows/claude-implement.yml` と同じ合図。定数は `src/config.ts` の `ISSUE_PICK_LABEL`）。`--issue N` で番号を指したときは、ラベルが無くても扱う。飛ばす：ラベル `agent-skip`・`tracking`、開いている PR が `Closes #n`・`Fixes #n` で指しているもの（同じ Issue に PR を重ねない）。ラベル「claude」の無い Issue は、数だけを記録に書く
2. 1件ごとに、本線から worktree を作る：`<worktree の根>/agent-issue-<n>`、ブランチ `agent/issue-<n>`
   - 根は環境変数 `SUKUSUKU_AGENT_WORKTREES`。既定はメインの作業ツリーの隣の `sukusuku-worktrees`
   - 前の実行の worktree やブランチが残っていたら、その Issue は飛ばす（消すのは持ち主）
3. エージェントに `prompts/issue.md` を渡す：本線で直っていれば根拠を書いて閉じる。直っていなければ直し（Go とモックの両方・両方にテスト・【仮置き】）、手元の CI を通し、日本語で commit、push、PR（`Closes #n`、節：何を・なぜ／決めたこと／人の判断を待つ／確かめたこと／確かめていないこと）。決めきれなければ下書きの PR で止まる。**マージはしない**
4. 結果（PR・閉じた・止めた・費用）は、コードが GitHub を見て決める

### merge

ラベル「マージ」を見ずに、開いている PR を全部見る前からの流れ。持ち主のアカウントでだけ動く。ふだんのマージは queue を使う（持ち主がラベルで決めたものだけを入れるため）。手元の CI の結果は、queue と同じく commit status で付ける。

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
schtasks /Create /SC DAILY /ST 08:00 /TN "sukusuku-api-agent-review-am" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\calif\sukusuku_system\agent-harness\api-agent\scripts\agent.ps1 review --max-usd 5"
schtasks /Create /SC DAILY /ST 20:00 /TN "sukusuku-api-agent-review-pm" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\calif\sukusuku_system\agent-harness\api-agent\scripts\agent.ps1 review --max-usd 5"
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
- `gh pr merge`（マージはコードだけ）、`gh pr close`、「マージ」のラベルの付け外し（queue では、付け外しもコードだけがする）、`gh repo delete/edit`・`gh issue delete`、`gh api` の書き込み（GET と mutation の無い graphql だけ許す）、`gh auth token`・`gh secret`・`gh workflow run`
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
- 止まるとき：上限に届いた、ぶつかりを解けない、CI が直らない、本線が進み続ける、push や `gh pr merge` が通らない、前の実行の worktree に変更が残っている。どれも記録に書いて次の件へ進む（queue は、ぶつかり・CI が赤・`.github/` のときだけ「マージ止め」にし、ほかはラベルをそのまま残す）
- **commit status・ラベル・Issue はコードだけが書く**（`src/shell.ts` の `postCommitStatus`・`editPrLabels`・`createIssue`）。エージェントの `gh api` の書き込み・`gh issue create`・「マージ」の付け外しは、守りのフックが断ったまま（変えていない）

## 手元の CI と鍵（`scripts/`）

- `local-ci.sh <worktree> <ログの置き場>`：CI のジョブと同じ確かめ（go vet・go test・npm ci・build・responsive／security の型検査・lint・vitest・結合・security・a11y）。結合と security のサーバは空いているポートで立てる。最後まで回ったら `result.txt` に `done=yes`
- `heavy.sh <コマンド…>`：重いコマンドを PC の中で1つずつ回す鍵。置き場は OS の一時フォルダの `sukusuku-heavy.lock`（環境変数 `SUKUSUKU_HEAVY_LOCK` で変えられる）。Claude Code の係・頭役も同じ鍵を使える。自分が取った鍵だけを外す。ただし、持ち主のプロセスが居なくなった鍵（強制終了で trap が走らずに残ったもの）は、取ってから2分たっていれば、待つ側が外して取り直す。持ち主が生きている鍵は外さない（40分待って 99）

## 定時に回す（Windows のタスク スケジューラー）

どれも `scripts\agent.ps1` を通す（キーは set-key.ps1 のファイルから、そのプロセスの中だけに戻す。`setx` は使わない）。記録は `runs/` に残る。

例1：マージ係（queue）を 30 分ごと【仮置き】に回す。持ち主がラベル「マージ」を付けてから、長くて 30 分と手元の CI の時間で入る。

```powershell
schtasks /Create /SC MINUTE /MO 30 /TN "sukusuku-api-agent-queue" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\calif\sukusuku_system\agent-harness\api-agent\scripts\agent.ps1 queue"
```

例2：毎晩 2:00 に `issues` を $10 の上限で回す（ラベル「claude」の Issue だけ）。

```powershell
schtasks /Create /SC DAILY /ST 02:00 /TN "sukusuku-api-agent" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\calif\sukusuku_system\agent-harness\api-agent\scripts\agent.ps1 issues --max-usd 10"
```

- 止めるときは `schtasks /Change /TN "sukusuku-api-agent-queue" /DISABLE`（ほかも同じ）
- 最初の何回かは手で回して、記録を見てから定時にする
- タスクは**持ち主の Windows のユーザーで**回す（`schtasks` を持ち主のターミナルで打てばそうなる）。キーのファイルは DPAPI なので、別のユーザーや「パスワードを保存しない」で回すと戻せない。そのときは agent.ps1 がキー無しで回す（queue はモデルを呼ばずに動き、ほかは終了コード 3 で止まる）
- 前の回がまだ動いているあいだは、タスク スケジューラーは新しい回を始めない（既定の「新しいインスタンスを開始しない」）。手元の CI が長いと、次の回は飛ぶ
- **GitHub の Actions が戻ったら**、`.github/workflows/merge.yml`（マージ係）・`claude-implement.yml`（ラベル claude の自動実装）・`claude-review.yml` と二重にならないように、queue・issues・review のタスクを止める（`/DISABLE`）。どちらも同じラベルを合図にしているので、両方が動くと同じ PR を2回入れようとしたり、同じ Issue に PR を2本出したりする

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
- queue が本線の先頭で手元の CI を回す worktree（`<worktree の根>/agent-main`）は、使い回す。変更が残っていると回さない（消すのは持ち主）。始めに回せないときは、列を止める
- 本線の先頭の手元の CI が赤（status が failure）のあいだ、queue は列を止める。時々落ちるテストで赤になったと見立てたら、`queue --recheck-main` で回し直す
- 本線に新しい commit が入るたび（ほかの人が入れたときも）、次の queue の始めに本線の先頭で手元の CI を1回回す。手元の CI は重いので、その回は PR に進むまで時間がかかる

## 仮置きの値

| 項目 | 仮置きの値 | 置いた場所 |
| :-- | :-- | :-- |
| 1回の実行の上限 | $10 | `src/config.ts` `DEFAULT_MAX_USD` |
| 1件の上限 | $3 | `src/config.ts` `DEFAULT_PER_ITEM_USD` |
| モデルを呼ぶ最小の残り | $0.05 | `src/config.ts` `MIN_CALL_USD` |
| 1回の query() の往復の上限 | Issue 200・ぶつかり 80・CI 120 | `src/config.ts` `MAX_TURNS` |
| 1回の query() の時間の上限 | Issue 120 分・ぶつかり 45 分・CI 90 分 | `src/config.ts` `QUERY_TIMEOUT_MIN` |
| 手元の CI 1回の時間の上限 | 120 分（鍵の待ちを含む） | `src/config.ts` `LOCAL_CI_TIMEOUT_MIN` |
| 定時の queue の間隔 | 30 分ごと（README の例だけ。コードには無い） | この README「定時に回す」 |

## 開発

```powershell
npm run typecheck   # tsc --noEmit
npm test            # 守りの表・引数・選び方・上限・CI の結果の読み取り・頼みの文・queue の判定（持ち主のラベル・並び・止める理由・持ち主の確かめ）・commit status
```

SDK の版は `package.json` で固定している（`@anthropic-ai/claude-agent-sdk` 0.3.296）。上げるときは、[TypeScript の参照](https://code.claude.com/docs/en/agent-sdk/typescript) の options（`settingSources`・`permissionMode`・`hooks`・`env`）と認証の順が変わっていないかを見る。
