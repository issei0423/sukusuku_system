# server — Go サーバ

Go 1.27 + SQLite。API と、React のビルド成果物の配信を行う。

```
go run .                      # http://localhost:8080
go run . -addr :9000          # 待ち受けアドレスを変える
go run . -db /path/to.db      # データベースの位置を変える
go run . -web ../web/dist     # 配信する静的ファイルの場所
```

初回起動時に `sukusuku.db` を作り、スキーマとデモデータを投入する。
デモ用の編集ロックは起動のたびに現在時刻へ寄せる（「他の職員が編集中」の状態をいつでも見せるため）。

## 構成

| ファイル | 内容 |
| :-- | :-- |
| `schema.sql` | 基本設計書「データベース設計」(5) の全37テーブルの DDL |
| `seed.sql` | デモデータ。氏名・メールアドレス・招待コード・測定値はすべて架空 |
| `db.go` | データベースの初期化と、成長曲線基準値の生成 |
| `session.go` | ログイン状態の保持。**方式は仮置き**（`web/仮置き値.md`） |
| `scope.go` | 参照範囲と権限の判定。**権限の担保はここ** |
| `oplog.go` | 操作ログ。追記のみ |
| `api_*.go` | 機能ごとのハンドラ |
| `routes.go` | エンドポイントの配線 |

## 選定の理由

- **SQLite** … `t_physical_record` の部分一意インデックス（`is_deleted = 0` の行のみ対象）に
  対応する必要がある。MySQL は非対応（基本設計書 5-7）
- **`modernc.org/sqlite`（純 Go）** … この環境には gcc が無く、cgo を必要とする
  `mattn/go-sqlite3` はビルドできない
- **`net/http` の `ServeMux`** … Go 1.22 以降はメソッドとパス変数を扱える。フレームワークは入れない

## 実装上の注意

**データベースの接続を1本に絞っている**（`db.SetMaxOpenConns(1)`）。SQLite は書き込みを
直列化するため、競合を避ける狙い。その代わり、**行を読みながら別の問い合わせを投げると
接続の取り合いで停止する。** 名前の解決などは必ずカーソルを閉じたあとに行うこと
（`api_diary.go` の `enrich`、`api_chat.go` の未読件数の数え上げが例）。

## 実装するエンドポイント

配線は `routes.go` にある。画面側は `web/src/api/http.ts` から呼ぶ。

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

動かすために仮に決めたものがある（`要決定事項.md` 優先度A）。**設計の決定ではない。**

- 認証情報の保持方式 → サーバ側セッション＋HttpOnly・SameSite=Strict の Cookie
- CSRF 対策の方式 → 独立した対策は未実装。SameSite=Strict は緩和策であって対策ではない
- パスワードのハッシュ方式 → bcrypt

詳細と、その他の仮置きは `web/仮置き値.md` を参照。
