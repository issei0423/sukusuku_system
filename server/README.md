# server — Go サーバ（未着手）

Go がこの環境にインストールされていないため、**Go のコードはまだ書いていない。**
先に、Go 側が実装することになる契約（スキーマとエンドポイント）だけを確定させている。

## 置いてあるもの

| ファイル | 内容 |
| :-- | :-- |
| `schema.sql` | 基本設計書「データベース設計」(5) の全37テーブルの DDL。SQLite で作成できることを確認済み |

`schema.sql` は `python -c "import sqlite3; sqlite3.connect(':memory:').executescript(open('schema.sql',encoding='utf-8').read())"` で検証している。
`t_physical_record` の部分一意インデックス（`is_deleted = 0` の行のみ対象）が、
削除した測定日への再登録を許しつつ生存行の重複を拒むことも確認した（基本設計書 5-7）。

## 着手の手順

1. Go をインストールする（`winget install GoLang.Go`）。インストール後は Claude Code の再起動が必要
2. `go mod init github.com/issei0423/sukusuku/server`
3. SQLite ドライバは **`modernc.org/sqlite`** を使う。この環境には gcc がなく、
   cgo を必要とする `mattn/go-sqlite3` はビルドできないため
4. ルーティングは Go 1.22 以降の `net/http` の `ServeMux` で足りる。フレームワークは入れない

## 実装するエンドポイント

`web/src/api/client.ts` に並ぶ関数が、そのままエンドポイントの一覧にあたる。
同ファイルは現在ブラウザ内の `mockDb.ts` を読み書きしているが、
Go 側ができたら**中身だけを fetch に差し替える**。画面側のコードは変更しない。

| 区分 | 関数（＝エンドポイント） |
| :-- | :-- |
| 認証 | `login` / `changePassword` / `agreeTerms` / `currentTerms` / `reloadSession` |
| 園児マスター | `listChildren` / `getChild` / `allergiesOf` / `allAllergies` / `medicalHistoriesOf` / `classOf` / `saveChild` / `removeChild` |
| 日誌 | `listDiaries` / `getDiary` / `templates` / `phrases` / `attachmentsOf` / `pastDiariesOf` / `acquireLock` / `releaseLock` / `lockOf` / `saveDiary` / `pendingDiaries` / `approveDiary` / `returnDiary` / `timelineOf` |
| チャット | `rooms` / `messages` / `readCount` / `markRead` / `send` / `retract` / `edit` / `members` / `createGroup` / `updateGroupMembers` / `groups` / `misdeliveryRecords` / `addMisdeliveryRecord` / `retractedWithoutRecord` |
| 午睡 | `activeSession` / `startSession` / `endSession` / `classState` / `record` / `recordAbnormal` / `raiseIncidentDiary` / `abnormals` / `searchRecords` |
| 発達 | `itemsFor` / `list` / `previousCheck` / `draftFor` / `saveCheck` / `schedules` / `setSchedule` / `shareSettings` / `setShareable` |
| 身体測定 | `classStatus` / `recordsOf` / `save` / `growthBand` / `remove` / `exportPdf` |
| アカウント管理 | `staffAccounts` / `reissueTempPassword` / `unlock` / `setAccountStatus` / `createStaffAccount` / `invitationCodes` / `issueInvitationCodes` / `issueOneInvitationCode` / `revokeInvitationCode` / `guardianAccounts` / `endGuardianLink` / `verifyInvitationCode` / `signUpGuardian` / `operationLogs` / `allAccounts` |
| 一括処理 | `parseChildCsv` / `importChildCsv` / `previewFiscalYearUpdate` |
| ダッシュボード | `staffSummary` / `guardianHome` |

## Go 側で必ず担保すること

**権限の判定はサーバ側の責任**（基本設計書「権限チェックの実装方針」(6-2)）。
画面側の出し分けは操作性のためであって、権限の担保ではない。
現在は `client.ts` の中で判定しており、その判定ロジックがそのまま Go へ移る。

判定の内容は `web/tests/permission.test.ts` が固定している。Go 側でも同じ観点のテストを書くこと。

- 一般（保育士）は自クラスの園児のみ
- 保護者は有効な紐づけのある自児のみ（`link_status='1'`）
- 管理者に限る操作：園児マスターの登録・編集、日誌の承認・差し戻し、操作ログの参照、
  招待コードの発行・失効、PDF出力、スケジュール設定、共有範囲設定、アカウント管理

## 未確定のまま残っているもの

Go の実装に入る前に決める必要がある（`要決定事項.md` 優先度A）。

- 認証情報の保持方式（Cookie / localStorage / セッションストア）
- CSRF 対策の方式
- パスワードのハッシュ方式（bcrypt / argon2 など）

`web/仮置き値.md`「モックで実装していないもの」も参照。
