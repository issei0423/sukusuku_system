# AWS の VM への自動デプロイ

公開先は AWS（東京リージョン）の VM の <https://54.65.117.115/>。Ubuntu、`t3.micro`（1GB・CPU クレジットは standard）、gp3 20GB（暗号化）。固定の IP（Elastic IP）が付いていて、セキュリティグループは 80/443 を全体へ、22 を持ち主の PC の IP だけへ開けている。リソースにはタグ `project=sukusuku` を付けてある。AWS は学校の組織の枠なので、作る・変えるときは先に料金を見て、最小で作る。

OCI の公開先（`deploy/oci-free/README.md`）と同じ置き場所を使う。アプリは `/opt/sukusuku`、データは `/var/lib/sukusuku`、systemd のサービス名は `sukusuku`、Go サーバは `127.0.0.1:8080` だけで待ち受け、Caddy が 80/443 を公開する。反映のスクリプトは OCI のもの（[sukusuku-deploy.sh](../oci-free/sukusuku-deploy.sh)）をそのまま使う。Caddy の設定はこのリポジトリに置いていない（VM 側のもの）。

## 更新の流れ

1. `mockup-go-react` への push で [deploy-aws.yml](../../.github/workflows/deploy-aws.yml) が動く。PR とほかのブランチでは公開しない。
2. `build` ジョブ（**GitHub 提供の runner**、`ubuntu-latest`）が、その commit を取り出し、`server/go.mod` の版の Go で静的検査（`go vet`）と Linux amd64 のビルド（`CGO_ENABLED=0`）、React の本番ビルド（`npm run build`。`build:demo` ではない）を行う。成果物 `sukusuku`（実行ファイル）・`web/`・`commit`（SHA 1 行）を 1 つの artifact（保持 1 日）にまとめる。
3. `deploy` ジョブ（VM の専用 self-hosted runner、ラベル `sukusuku-aws`）が、ジョブの前にフックで出どころを確かめられたあと、(a) この commit がまだ本線の先頭かを GitHub の API で見る（進んでいたら反映せず、新しい実行に任せる）、(b) artifact を受け取る、(c) `sudo /usr/local/sbin/sukusuku-deploy` で配置する、(d) 外から `/`・`/api/terms`・`/api/me`（未ログインで 401）を確かめる、(e) 受け取った成果物を消す。
4. `sukusuku-deploy` は SQLite のバックアップを取り、新しい release を作って `current` を切り替え、サービスを再起動する。`http://127.0.0.1:8080/` が 30 秒以内に応答しなければ、前の release へ戻して失敗で終わる。

**VM ではビルドしない。** t3.micro は CPU クレジットが standard（使い切ると上限へ絞られ、追加の課金は無い）で、1GB しかなく、Go と React のビルドは重い（OCI の VM では 1 回の反映が約 25 分かかっていた）。VM がするのは、できた成果物を置いてサービスを再起動することだけ。

**テストは回さない。** `go vet` とビルドが通ることだけを確かめる（`deploy-oci.yml` と同じ考え）。Go・画面・結合・セキュリティ・アクセシビリティのテストは、マージの前に PR の CI（`ci.yml`）で回す。この反映は CI の成功を条件にしていない（本線への push で CI と並んで動く）ので、緑の PR だけをマージする。

`concurrency` で同時に反映するのは 1 本だけにしてある。走っているものは取り消さず、新しい push は待つ。

## 費用

- AWS 側の追加は無い（既存の VM のみ。runner の登録・artifact に AWS のサービスは使わない）。
- GitHub 提供の runner は、リポジトリが public なので無料。artifact は保持 1 日で、保存枠もほぼ使わない。
- VM への SSH 鍵や AWS のキーを GitHub Secrets に登録する必要は無い。runner が GitHub へ外向きの HTTPS で接続するだけで、22 番を GitHub へ開けない。

## VM 側の一回限りの準備（頭役・持ち主が VM で行う）

VM へは、22 番を開けた持ち主の PC から SSH で入る。**VM を作り直さない。** 以下はこの PR のマージ後、最初の反映の前に行う。

1. **runner の専用ユーザー** `sukusuku-runner` を作る（ログインシェルは不要、sudo は下の 1 つだけ）。runner は GitHub の[公式手順](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)で、**このリポジトリ専用**の Linux x64 として、このユーザーで展開・登録する。名前は `sukusuku-aws`、追加ラベルも `sukusuku-aws`（`deploy-aws.yml` の `runs-on` が `[self-hosted, linux, x64, sukusuku-aws]`）。systemd のサービスとして動かす。登録トークンは短命。コマンドやログを公開しない。
2. **反映のコマンドを置く。** OCI のスクリプトをそのまま、root 所有・0755 で置く。

   ```sh
   sudo install -m 0755 -o root -g root sukusuku-deploy.sh /usr/local/sbin/sukusuku-deploy
   ```

3. **sudo は反映のコマンドだけに限る。** GitHub から来る任意のジョブを root で走らせない。

   ```sh
   echo 'sukusuku-runner ALL=(root) NOPASSWD: /usr/local/sbin/sukusuku-deploy' | sudo tee /etc/sudoers.d/sukusuku-runner
   sudo chmod 0440 /etc/sudoers.d/sukusuku-runner
   sudo visudo -c
   ```

   置いたあとで `sudo -l -U sukusuku-runner` を見て、ほかのコマンドが許されていないことを確かめる。
4. **フックを置く**（下の「ジョブの出どころを確かめるフック」）。
5. **最初の release へ移す。** `sukusuku-deploy` は `/opt/sukusuku/current` と、`sukusuku`・`web` の 2 つのリンクが無いと「初回移行が済んでいません」で止まる。手順は OCI の README の「VM 側の一回限りの準備」の、最初の release へ移す項（`releases/initial/` へコピーし、`current` をそこへのリンクにし、従来の 2 パスを `current/sukusuku`・`current/web` へのリンクにする）と同じ。`sukusuku.service`（[../oci-free/sukusuku.service](../oci-free/sukusuku.service)）のパスはそのままでよい。サービス再起動と `http://127.0.0.1:8080/` の応答を確かめてから、自動反映を有効にする。
6. **アプリの環境ファイル** `/etc/sukusuku/sukusuku.env`（任意）は root 所有・0600 にして置く。Anthropic API キーは置かず、AI は無効のままにする。
7. Caddy・ファイアウォール（セキュリティグループ）は、自動反映では変えない。

### 確かめ方

- 本線への次の push で、「AWS へ自動デプロイ」の `build` と `deploy` が緑になる。`deploy` のログの `Set up runner` に、`A job started hook has been configured by the self-hosted runner administrator` と「続けます」の行が出る。
- VM で `systemctl status sukusuku caddy`、`journalctl -u sukusuku -n 100`。実行中の commit は `/opt/sukusuku/current/commit`。

## ジョブの出どころを確かめるフック

[sukusuku-runner-job-started.sh](sukusuku-runner-job-started.sh) は、runner がジョブを走らせる前に呼ぶ台本（`ACTIONS_RUNNER_HOOK_JOB_STARTED`）。OCI の台本（`deploy/oci-free/sukusuku-runner-job-started.sh`）の写しで、通すワークフローだけが違う。次の 4 つがすべてそのまま合うときだけ 0 で終わる。1 つでも違えば、わけをログに出して 1 で終わる。0 以外で終わると、ジョブは走らずに失敗になり、ステップは一つも動かない（GitHub Docs「[Running scripts before or after a job](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts)」）。

| 変数 | 通す値 |
| :-- | :-- |
| `GITHUB_REPOSITORY` | `issei0423/sukusuku_system` |
| `GITHUB_EVENT_NAME` | `push` |
| `GITHUB_REF` | `refs/heads/mockup-go-react` |
| `GITHUB_WORKFLOW_REF` | `issei0423/sukusuku_system/.github/workflows/deploy-aws.yml@refs/heads/mockup-go-react` |

どれも GitHub が入れる既定の変数で、ワークフローから上書きできない（GitHub Docs「[Variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables)」）。`deploy-oci.yml` のジョブは、この runner では止まる（テストにある）。

判定は、手元で `bash deploy/aws/sukusuku-runner-job-started.test.sh` を回して確かめる（`bash deploy/oci-free/sukusuku-runner-job-started.test.sh` は OCI の台本の分）。この runner に別のワークフローや別のイベントを載せるときは、先に台本の通す値とテストを直す。

### 置き方（デプロイが走っていないときに行う）

1. 台本を root 所有・0755 で置く。runner は拡張子で台本の種類を見分けるので、`.sh` を付けたまま置く。

   ```sh
   sudo install -m 0755 -o root -g root sukusuku-runner-job-started.sh /usr/local/sbin/sukusuku-runner-job-started.sh
   ```

2. runner のフォルダ（`config.sh` があるところ）の `.env` に 1 行足す。登録のときに書かれた行があるので、上書きしない。

   ```sh
   ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/sbin/sukusuku-runner-job-started.sh
   ```

3. `.env` を root 所有・0644 にして、`sukusuku-runner` が書き換えられないようにする。

   ```sh
   sudo chown root:root .env
   sudo chmod 0644 .env
   ```

4. runner のサービスを再起動する。`.env` は runner の起動のときにだけ読まれる（サービス名は `systemctl list-units 'actions.runner.*'` で見る）。

runner を登録し直す（`config.sh`）ときは、`.env` に行を足すことがある。root 所有のままでは足せずにエラーが出るので、登録のあとに `.env` を見直す。

## 止め方・戻し方

- **自動反映を止める。** 一番早いのは runner のサービスを止めること（`sudo systemctl stop 'actions.runner.*'`）。`deploy` ジョブは runner を待ち、`build` だけが GitHub 側で動く。再開は `start`。恒久的に止めるときは、GitHub の Settings → Actions → Runners でこの runner を外し、`deploy-aws.yml` を本線から消す（PR を持ち主が見て入れる）。
- **前の release へ戻す。** 新しいアプリが応答しなければ、`sukusuku-deploy` は自分で前の release へ戻す。手で戻すときは、`/opt/sukusuku/releases/` の戻したい commit を選び、`sudo ln -s releases/<commit> /opt/sukusuku/current.next && sudo mv -Tf /opt/sukusuku/current.next /opt/sukusuku/current && sudo systemctl restart sukusuku`。戻したままにしたいなら、先に自動反映を止める（次の本線への push で、新しいものが反映される）。
- **データベース。** 反映のたびに、更新前のオンラインバックアップを root だけが読める `/var/backups/sukusuku/` に取る。スキーマを変えたときの DB の復元は自動化していないので、復旧のときに確かめる。
- **古い release は自動では消えない。** `/opt/sukusuku/releases/` と `/var/backups/sukusuku/` は反映のたびに増える。gp3 20GB なので、ときどき見て、古いものを持ち主が消す。
- **フックだけを戻す。** `.env` から `ACTIONS_RUNNER_HOOK_JOB_STARTED=` の行を消してから、サービスを再起動する。台本だけを先に消さない（`.env` に行が残ったまま台本が無いと、runner はジョブを止める）。

## self-hosted runner の危うさ

runner は、届いたジョブのコマンドを `sukusuku-runner` として VM の上で実行する。

- このリポジトリは public。ワークフローは、本線に入っていなくても、そのブランチへの push で動く。`runs-on` がこの runner に合えば、そのジョブは VM に届く。本線に保護は無い（2026-11-06 に確かめた）。
- 外の人の fork からの PR のワークフローは、承認してから走る。
- ワークフローごとに runner を絞れる runner グループは、organization と enterprise の機能で、個人のアカウントのリポジトリにはない。そこで、ジョブの前に動くフックで、**本線への push で動いた `deploy-aws.yml` のジョブだけ**を通す。
- `sukusuku-deploy` は、成果物の形と commit SHA の形だけを見る。SHA は呼ぶ側が渡す名前で、成果物の中身とは結びつかない。守りはフックに置く。
- フックは本線そのものは疑わない。本線へ入った変更は、そのまま VM で動く。`.github/` を変える PR は、マージ係が止め、持ち主が見てから手で入れる（`AGENTS.md`）。
- 守れないこともある。runner のフォルダと本体は `sukusuku-runner` のものなので、`.env` を root 所有にしても、走ったジョブがフォルダの中を入れ替えることはできる。フックは本線以外のジョブを走る前に止めるもので、走ったジョブから runner を守るものではない。フックの前に、runner はジョブが使うアクションを VM へ取得して展開する（中身は動かさない）。
- `deploy` ジョブは、ソースを取り出さず（`checkout` しない）、成果物を受け取って反映するだけにしてある。VM でソースのコードを走らせない。

## 注意

- 外向きの確認（`deploy-aws.yml` の「外部 HTTPS を確認」）は `curl -k` で、証明書の検証をしない。公開先の証明書の種類は VM 側の Caddy の設定で決まるため。証明書を正式なものにしたら `-k` を外す。
- AWS の IP（Elastic IP）を変えたら、`deploy-aws.yml` の URL を合わせる。
