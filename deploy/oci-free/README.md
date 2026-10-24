# 既存 OCI VM への自動デプロイ

公開先は大阪リージョンの既存 VM `sukusuku`（Ubuntu 24.04、`VM.Standard.E2.1.Micro`）の <https://217.142.235.206>。Go サーバは `127.0.0.1:8080` だけで待ち受け、Caddy が 80/443 を公開する。OCI Bastion 経由の SSH だけを使い、22 番をインターネットには公開しない。

## 更新の流れ

1. `mockup-go-react` への push で [deploy-oci.yml](../../.github/workflows/deploy-oci.yml) が動く。PR とほかのブランチでは公開しない。
2. VM の専用 self-hosted runner が GitHub へ外向き HTTPS で接続し、本線の commit を取得する。Go の静的検査とテスト、Go 1.27.3 と React のビルドを順に行う。古い commit なら反映しない。
3. VM 上の [sukusuku-deploy.sh](sukusuku-deploy.sh) が SQLite のバックアップを取り、アプリを差し替えてサービスを再起動する。外部 HTTPS、公開 API、未ログイン時の保護も確認する。結果は Actions の実行画面に残る。

GitHub 提供 runner の実行分数と artifact 保存枠は使わない。VM への SSH 鍵や OCI API キーを GitHub Secrets に登録する必要もなく、22 番は開けない。約 1 GB の VM でのビルド用に swap を用意し、同時に一つのデプロイだけを走らせる。runner が止まっている間のデプロイは待機する。

既存の `CI（テスト）` は GitHub 提供 runner を使っており、現状は分数上限で開始できない。この自動デプロイはその CI の成功を条件にできないため、VM 内で Go テストと React ビルドを行う。画面テスト・結合テスト・セキュリティレビュー・アクセシビリティテストまでは代替しない。持ち主の PR レビューとローカルテストを省かない。

## VM 側の一回限りの準備

既存 VM に Bastion の一時セッションで接続して作業する。VM を作り直さない。

- GitHub の[公式手順](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)で、**この非公開リポジトリ専用**の Linux x64 runner を作る。名前は `sukusuku-prod`、追加ラベルも `sukusuku-prod`。専用の一般ユーザー `sukusuku-runner` で systemd サービスとして動かす。登録トークンは短命なので、コマンドやログを公開しない。
- `sukusuku-deploy.sh` を root 所有・0755 で `/usr/local/sbin/sukusuku-deploy` に配置する。`sukusuku-runner` の sudo 権限はこのコマンドだけに限る。GitHub から来る任意のジョブを root で走らせない。
- 最初のデプロイの前に、既存の `/opt/sukusuku/sukusuku` と `/opt/sukusuku/web` を `/opt/sukusuku/releases/initial/` へコピーする。`/opt/sukusuku/current` を `releases/initial` へのリンクにし、従来の 2 パスもそれぞれ `current/sukusuku` と `current/web` へのリンクにする。`sukusuku.service` のパスはそのままでよい。サービス再起動と `http://127.0.0.1:8080/` の確認を終えてから自動デプロイを有効にする。
- `Caddyfile.ip` は現在の VM の Caddy 設定。自動デプロイでは Caddy とファイアウォールは変更しない。

runner は本線から届いたジョブのコマンドを VM 上で実行できる。`.github/` の変更は通常の PR より慎重にレビューし、リポジトリの決まりどおり持ち主がマージを判断する。

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
