# PR #{{PR_NUMBER}} の手元の CI が落ちた

worktree `{{WORKTREE}}` は、PR のブランチ `{{HEAD_BRANCH}}` の先に本線（origin/{{BASE}}）を取り込んだ形（HEAD は切り離してある）。ここで手元の CI（CI のジョブと同じ確かめ）を回したら、落ちた。わけを見立てて、分け方のとおりにする。

## PR

- 題：{{PR_TITLE}}
- URL：{{PR_URL}}

## 手元の CI の結果

{{CI_RESULT}}

ログ：`{{CI_LOG_DIR}}/<名前>.log`（go-vet.log・go-test.log・npm-ci.log・build.log・lint.log・vitest.log・integration.log・security.log・a11y.log など）

## すること

1. 落ちたもののログを読み、わけを見立てる。PR の差分は `git diff origin/{{BASE}}...HEAD`、本線から入った変更は `git log --oneline HEAD^2 ^HEAD^1`（取り込みの commit があるとき）で見る。
2. 見立てで、次のどれかにする。
   - **その PR と関わらない、時々落ちるテスト**（時刻・待ち時間・ポート・メモリ・並行の負荷など、PR の差分と関係のない所で落ちた）：直さない。わけを書いて `判定: 回し直す`。
   - **PR の落ち**（PR の変更か、本線を取り込んだことで落ちた）：この worktree で直し、関わるテストを鍵を通して回し（`bash "{{HEAVY}}" <コマンド>`）、日本語のメッセージで commit する。最後の行は `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。`判定: 直した`。
   - **直せない**・直すには設計の判断が要る：何も commit せずに `判定: 直せない <わけ>`。
3. **落ちたテストを、期待値の書き換えで通さない**（規則が変わったのか、不具合なのかを先に確かめる）。web のテストの時計は日本時間の 18:00 で止めてあり、Go のテストと結合テストは本物の時計で動く（AGENTS.md「テストで気をつけること」）。
4. **push とマージはしない**（コードがする）。手元の CI をまるごと回し直すのもコードがする。commit していない変更を残さない。

## 最後に

終わりの返事の最後の行を、次のどれかにする（コードが読む）。

- `判定: 回し直す`
- `判定: 直した`
- `判定: 直せない <わけ>`
