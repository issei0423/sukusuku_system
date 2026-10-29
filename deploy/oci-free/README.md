# 既存 OCI VM への自動デプロイ

公開先は大阪リージョンの既存 VM `sukusuku`（Ubuntu 24.04、`VM.Standard.E2.1.Micro`）の <https://217.142.235.206>。Go サーバは `127.0.0.1:8080` だけで待ち受け、Caddy が 80/443 を公開する。OCI Bastion 経由の SSH だけを使い、22 番をインターネットには公開しない。

## 更新の流れ

1. `mockup-go-react` への push で [deploy-oci.yml](../../.github/workflows/deploy-oci.yml) が動く。PR とほかのブランチでは公開しない。
2. VM の専用 self-hosted runner が GitHub へ外向き HTTPS で接続し、ジョブを受け取る。runner はジョブを走らせる前に、フックでジョブの出どころを確かめる（下の「ジョブの出どころを確かめるフック」）。本線の commit を取得し、Go の静的検査とテスト、Go 1.27.3 と React のビルドを順に行う。古い commit なら反映しない。
3. VM 上の [sukusuku-deploy.sh](sukusuku-deploy.sh) が SQLite のバックアップを取り、アプリを差し替えてサービスを再起動する。外部 HTTPS、公開 API、未ログイン時の保護も確認する。結果は Actions の実行画面に残る。

GitHub 提供 runner の実行分数と artifact 保存枠は使わない。VM への SSH 鍵や OCI API キーを GitHub Secrets に登録する必要もなく、22 番は開けない。約 1 GB の VM でのビルド用に swap を用意し、同時に一つのデプロイだけを走らせる。runner が止まっている間のデプロイは待機する。

既存の `CI（テスト）` は GitHub 提供 runner を使っており、現状は分数上限で開始できない。この自動デプロイはその CI の成功を条件にできないため、VM 内で Go テストと React ビルドを行う。画面テスト・結合テスト・セキュリティレビュー・アクセシビリティテストまでは代替しない。持ち主の PR レビューとローカルテストを省かない。

## VM 側の一回限りの準備

既存 VM に Bastion の一時セッションで接続して作業する。VM を作り直さない。

- GitHub の[公式手順](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)で、**この非公開リポジトリ専用**の Linux x64 runner を作る。名前は `sukusuku-prod`、追加ラベルも `sukusuku-prod`。専用の一般ユーザー `sukusuku-runner` で systemd サービスとして動かす。登録トークンは短命なので、コマンドやログを公開しない。
- `sukusuku-deploy.sh` を root 所有・0755 で `/usr/local/sbin/sukusuku-deploy` に配置する。`sukusuku-runner` の sudo 権限はこのコマンドだけに限る。GitHub から来る任意のジョブを root で走らせない。
- `sukusuku-runner-job-started.sh` を置き、runner がジョブの前に呼ぶようにする（下の「ジョブの出どころを確かめるフック」）。
- 最初のデプロイの前に、既存の `/opt/sukusuku/sukusuku` と `/opt/sukusuku/web` を `/opt/sukusuku/releases/initial/` へコピーする。`/opt/sukusuku/current` を `releases/initial` へのリンクにし、従来の 2 パスもそれぞれ `current/sukusuku` と `current/web` へのリンクにする。`sukusuku.service` のパスはそのままでよい。サービス再起動と `http://127.0.0.1:8080/` の確認を終えてから自動デプロイを有効にする。
- `Caddyfile.ip` は現在の VM の Caddy 設定。自動デプロイでは Caddy とファイアウォールは変更しない。

runner は、届いたジョブのコマンドを `sukusuku-runner` として VM 上で実行する。届くのは本線のジョブだけではない。ワークフローは本線に入っていなくても、そのブランチへの push で動き、`runs-on` がこの runner に合えば VM に届く。このリポジトリは無料プランの非公開リポジトリで、本線を保護できない。ワークフローごとに runner を絞れる runner グループは organization と enterprise の機能で、個人のアカウントのリポジトリにはない。そこで、ジョブの前に動くフックで、本線への push で動いた `deploy-oci.yml` のジョブだけを通す。

`sukusuku-deploy` は、成果物の形と commit SHA の形だけを見る。その SHA が本線の先頭かは見ない。SHA は呼ぶ側が渡す名前で、成果物の中身とは結びつかないため、ここで本線と照らしても守りにならない。守りは、本線以外のジョブを走らせないフックに置く。

フックは本線そのものは疑わない。本線へ入った変更（依存の更新を含む）は、そのまま VM で動く。`.github/` の変更は通常の PR より慎重にレビューし、リポジトリの決まりどおり持ち主がマージを判断する。

## ジョブの出どころを確かめるフック

[sukusuku-runner-job-started.sh](sukusuku-runner-job-started.sh) は、runner がジョブを走らせる前に呼ぶ台本（`ACTIONS_RUNNER_HOOK_JOB_STARTED`）。次の 4 つがすべてそのまま合うときだけ 0 で終わる。1 つでも違えば、わけをログに出して 1 で終わる。0 以外で終わると、ジョブは走らずに失敗になり、ステップは一つも動かない（GitHub Docs「[Running scripts before or after a job](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts)」）。

| 変数 | 通す値 |
| :-- | :-- |
| `GITHUB_REPOSITORY` | `issei0423/sukusuku_system` |
| `GITHUB_EVENT_NAME` | `push` |
| `GITHUB_REF` | `refs/heads/mockup-go-react` |
| `GITHUB_WORKFLOW_REF` | `issei0423/sukusuku_system/.github/workflows/deploy-oci.yml@refs/heads/mockup-go-react` |

どれも GitHub が入れる既定の変数で、ワークフローから上書きできない（GitHub Docs「[Variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables)」）。runner 2.338.1 の実装でも、フックの環境はワークフローの `env` を含まず、ジョブの `github` の文脈から作られる。

判定は、手元で `bash deploy/oci-free/sukusuku-runner-job-started.test.sh` を回して確かめる。この runner に別のワークフローや別のイベントを載せるときは、先に台本の通す値とテストを直す。

### 置き方（持ち主が VM で行う）

デプロイが走っていないときに行う。

1. このフォルダの `sukusuku-runner-job-started.sh` を VM へ写し、root 所有・0755 で置く。runner は拡張子で台本の種類を見分けるので、`.sh` を付けたまま置く。

   ```sh
   sudo install -m 0755 -o root -g root sukusuku-runner-job-started.sh /usr/local/sbin/sukusuku-runner-job-started.sh
   ```

2. runner のフォルダ（runner を展開した、`config.sh` があるところ）の `.env` に 1 行足す。`.env` には登録のときに書かれた行があるので、上書きしない。

   ```sh
   ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/sbin/sukusuku-runner-job-started.sh
   ```

3. `.env` を root 所有・0644 にして、`sukusuku-runner` が書き換えられないようにする。runner は読めればよい。

   ```sh
   sudo chown root:root .env
   sudo chmod 0644 .env
   ```

4. runner のサービスを再起動する。`.env` は runner の起動のときにだけ読まれる。`svc.sh install` で作ったサービスなら、名前は `actions.runner.` で始まる（`systemctl list-units 'actions.runner.*'` で見る）。

### 確かめ方

- 本線への次の push で、「OCI へ自動デプロイ」の `deploy` が緑になる。ジョブのログの `Set up runner` に、`A job started hook has been configured by the self-hosted runner administrator` と「続けます」の行が出る。
- 持ち主が自分の作業ブランチで、この runner を指定した試しのワークフローを push し、ジョブが `Set up runner` で失敗して、ステップが走らないことを見る。試しの中身は `echo` だけにする（フックが効いていなければ、VM の上で走るため）。確かめたら、試しのワークフローをブランチから消す。

### 戻し方

1. `.env` から `ACTIONS_RUNNER_HOOK_JOB_STARTED=` の行を消す（root 所有なので `sudo` で編集する）。
2. runner のサービスを再起動する。

台本だけを先に消さない。`.env` に行が残ったまま台本が無いと、runner は台本が見つからずにジョブを止める。

### このフックで守れないこと

- 本線そのもの。本線は保護できないので、write の権限がある人は本線へ直接 push できる。本線へ入った変更はフックを通り、VM で動く。
- 走ったジョブ。runner のフォルダと runner の本体は `sukusuku-runner` のものなので、`.env` を root 所有にしても、フォルダの中でファイルを入れ替えることはできる。フックは本線以外のジョブを走る前に止めるもので、走ったジョブから runner を守るものではない。
- フックの前に、runner はジョブが使うアクションを VM へ取得して展開する。アクションの中身は動かさない（runner 2.338.1 の実装。コンテナの準備はフックのあと）。

runner を登録し直す（`config.sh`）ときは、`.env` に行を足すことがある（`env.sh`）。root 所有のままでは足せずにエラーが出るので、登録のあとに `.env` を見直す。

## 確認と復旧

- Actions の「OCI へ自動デプロイ」で `deploy` が緑になったことを確認する。外部から <https://217.142.235.206> を開く。
- VM で `systemctl status sukusuku caddy` と `journalctl -u sukusuku -n 100` を見る。実行中の commit は `/opt/sukusuku/current/commit` にある。
- 新しいアプリがローカルで応答しなければスクリプトは前の実行ファイルと画面へ戻す。更新前の SQLite バックアップは root だけが読める `/var/backups/sukusuku/` に残す。スキーマ変更時の DB 復元は自動化していないので、復旧時に確認する。

## アクセスログ

`Caddyfile.ip` の `log` で、Caddy が1件ずつのアクセスを `/var/log/caddy/sukusuku-access.log`（JSON、1行1件）に残す。2026-10-24 より前は `log` が無く、アクセスは残っていない。アプリの操作ログ（`t_operation_log`）は書き換え・CSV の出力・ログインの失敗だけで、ログインの成功と送信元の IP は残らない。

- 置き方（持ち主が Bastion のセッションで行う）：`sudo cp Caddyfile.ip /etc/caddy/Caddyfile`、`sudo caddy validate --config /etc/caddy/Caddyfile`、`sudo systemctl reload caddy`。`/var/log/caddy` が無ければ `sudo install -d -o caddy -g caddy -m 0750 /var/log/caddy`
- 見方：`sudo tail -n 50 /var/log/caddy/sukusuku-access.log | jq -c '{ts, ip: .request.remote_ip, m: .request.method, uri: .request.uri, st: .status}'`。ログインの試しだけなら `jq -c 'select(.request.uri == "/api/login") | {ts, ip: .request.remote_ip, st: .status}'`
- Cookie・Set-Cookie・Authorization は Caddy が伏せて書く。送信元の IP と URL は残るので、ログを外へ出さない。残す期間は 30 日【仮置き】

デモデータには既知の共通パスワード `pass1234` がある。現在の公開先はデモ専用とし、実データを入れない。Anthropic API キーは VM に置かず、AI は無効のままにする。

## 設置状況（2026-10-23）

既存 VM に runner 2.338.1 を専用ユーザーで登録し、GitHub 側の online を確認した。4GB の swap と release 切替用の配置、更新コマンドだけの sudo 権限を設定済み。初期配置は releases/initial に保持している。自動反映はこの PR のマージ後から有効になる。

VM で依存ライブラリをゼロからコンパイルすると、Anthropic SDK で30分以上かかり swap 使用量が約2GBに達した。初回は手元の WSL Ubuntu で同じ Go のキャッシュを作り、runner のホームへ配置した。キャッシュありの VM で Go ビルド約53秒、npm ci 約48秒、React の型検査とビルド約169秒を確認した。Go の版や大きな依存関係の更新時は、再び重い初回コンパイルが必要になる場合がある。

専用ユーザーの sudo 経由で成果物の反映と SQLite バックアップを確認した。起動失敗時の旧配置への切戻し、修正後の反映、外部 HTTPS のトップ画面と公開 API の200・未認証 APIの401を確認済み。GitHub Actions のイベントから最後までの一連の実行は、持ち主が PR をマージした後に確認する。既存依存関係の npm audit は5件（moderate 2、high 3）を報告したため、別途精査する。
