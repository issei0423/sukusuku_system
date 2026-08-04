# 保育支援システム ER図

| 項目 | 内容 |
| :-- | :-- |
| 対象システム | 保育支援システム（すくすくシステム） |
| 版数 | 第 1.0 版 |
| 作成日 | 2026 年 8 月 4 日 |
| 典拠 | `HFD_要件定義書02_レビュー編集済み.md` 第1.7版 |
| 作成区分 | チーム開発演習 基本設計 |

## 改訂履歴

| 版 | 日付 | 変更内容 |
| :-: | :-: | :-- |
| 1.0 | 2026/08/04 | 新規作成。全体要件定義書 第1.7版の全機能からエンティティを抽出し、6つのサブジェクトエリアに分けて図示 |

# 0 本書の位置づけ

- 本書は**図**であり、エンティティとその関連、および各エンティティの主要な属性を示す。**列の完全な定義（型・制約・既定値・チェック仕様）は基本設計書が保持する。**
- 既に作成済みの `基本設計書（身体記録のみ）.md` 第3.0版が定義しているエンティティ（`m_child` / `t_physical_record` / `m_growth_standard` / `m_setting`）は、その定義を正としてそのまま取り込んでいる。
- 全体要件定義書と本書の記述が食い違った場合は、**全体要件定義書を正とし、本書を追随させる。**

## 0-1 命名規則

`基本設計書（身体記録のみ）.md` 5章およびマスタ文書の書式に統一する。

| 区分 | 接頭辞 | 例 |
| :-- | :-- | :-- |
| マスタ（変更頻度が低く、参照される側） | `m_` | `m_child`、`m_class`、`m_setting` |
| トランザクション（業務の実行に伴い増える） | `t_` | `t_diary`、`t_nap_record` |

| 項目 | 規則 |
| :-- | :-- |
| 代理キー | `BIGINT` 自動採番。列名は `<テーブル名の主語>_id` |
| 園児ID・職員ID・保護者ID | `VARCHAR(20)`。園が付番する業務上のIDを想定する |
| 論理削除 | `is_deleted BOOLEAN`（全体要件定義書 7-3 No.6）。削除者・削除日時は共通操作ログ側で保持する |
| 時刻列 | `created_at` / `updated_at`（`DATETIME`）。**サーバの時刻**を用いる（同 4-2 (3)） |
| 区分値 | `CHAR(1)` の数字コード。意味は各図の備考に記す |

# 1 全体像

サブジェクトエリアの関係を示す。園児マスタ（`m_child`）が全機能の基盤であり、アカウント（`m_account`）が権限判定の起点となる。

```mermaid
flowchart TB
    subgraph AC["アカウント・権限"]
        A1["m_account / m_staff / m_guardian<br>t_invitation_code"]
    end
    subgraph CH["園児・クラス"]
        C1["m_child / m_class<br>t_class_child / t_class_staff / t_guardian_child"]
    end
    subgraph DI["日誌"]
        D1["t_diary / t_diary_lock<br>m_diary_template"]
    end
    subgraph CT["チャット"]
        T1["m_chat_room / t_chat_message<br>t_chat_member / t_chat_read"]
    end
    subgraph NP["午睡チェック"]
        N1["t_nap_session / t_nap_record<br>t_nap_abnormal"]
    end
    subgraph DV["発達チェック・身体測定"]
        V1["t_development_check / t_development_result<br>t_physical_record / m_growth_standard"]
    end
    subgraph CM["共通"]
        M1["t_operation_log / m_setting / m_terms"]
    end

    CH --> AC
    DI --> CH
    CT --> CH
    NP --> CH
    DV --> CH
    DI -.->|共有| CT
    DV -.->|共有| CT
    NP -.->|ヒヤリハット起票| DI
    AC --> CM
    DI --> CM
    CT --> CM
    NP --> CM
    DV --> CM
```

- 実線は参照（外部キーを伴う関連）、点線は**機能間のデータの引き渡し**を示す。
- 日誌・発達チェックからチャットへの点線は、共有可否フラグを付けて個人チャットへ引き渡す連携（4-2 (1)・4-2 (4)）。
- 午睡チェックから日誌への点線は、異常時の記録からヒヤリハットを下書き起票する連携（4-2 (1)）。

# 2 エリア別ER図

## 2-1 アカウント・権限

```mermaid
erDiagram
    m_account ||--o| m_staff : "職員プロフィール"
    m_account ||--o| m_guardian : "保護者プロフィール"
    m_account ||--o{ t_invitation_code : "登録に使用"
    m_terms ||--o{ m_account : "同意した版"

    m_account {
        bigint account_id PK "自動採番"
        varchar email UK "ログインID。園内で一意"
        varchar password_hash "ハッシュ化して保存"
        char role "1:管理者 2:一般 3:保護者"
        char status "1:有効 2:停止"
        boolean is_temp_password "一時パスワードでのログイン中"
        datetime temp_password_expires_at "一時パスワードの有効期限"
        int failed_login_count "連続認証失敗回数"
        datetime locked_until "ロック解除予定時刻"
        varchar terms_version "同意した利用規約の版"
        datetime terms_agreed_at "同意日時"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    m_staff {
        varchar staff_id PK "園が付番する職員ID"
        bigint account_id FK "m_account を参照。一意"
        varchar staff_name "氏名"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    m_guardian {
        varchar guardian_id PK "保護者ID"
        bigint account_id FK "m_account を参照。一意"
        varchar guardian_name "氏名"
        varchar phone_number "緊急連絡先の電話番号。下記の要確認を参照"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    m_terms {
        bigint terms_id PK "自動採番"
        varchar terms_version UK "版。例 1.0"
        char document_type "1:利用規約 2:プライバシーポリシー"
        text body "本文"
        date published_on "施行日"
    }
    t_invitation_code {
        bigint invitation_code_id PK "自動採番"
        varchar code UK "推測困難な値"
        varchar child_id FK "紐づく園児"
        date expires_on "有効期限"
        char status "1:未使用 2:使用済 3:失効"
        bigint used_account_id FK "登録に使用したアカウント"
        datetime used_at "使用日時"
        varchar issued_staff_id FK "発行した管理者"
        datetime created_at "発行日時"
    }
```

**設計上の判断**

- **認証情報を `m_account` に集約し、職員・保護者のプロフィールを別テーブルに分けた。** ログインIDであるメールアドレスは**ロールをまたいで園内で一意**でなければならない（4-1-1。職員が自児の保護者アカウントを取る場合に別のメールアドレスを要する根拠）。職員表・保護者表に別々に持つと、この一意性をデータベースの制約で担保できない。
- `m_staff.staff_id` は既存の `t_physical_record.staff_id`（基本設計書 5-1）が参照しているため、`VARCHAR(20)` の業務IDとして維持する。
- 一時パスワードは `password_hash` を上書きし、`is_temp_password` と `temp_password_expires_at` で状態を表す。**再発行のたびに旧パスワードは無効になる**（4-1-1）。期限切れ後はどのパスワードでもログインできない状態となり、`locked_until` によるロックとは区別する。
- 規約改定時の再同意は `m_account.terms_version` の更新で表す。**過去に同意した版の履歴を残す必要がある場合は、`t_terms_agreement`（account_id + terms_version + agreed_at）を別に設ける**（下記 6-2 No.1）。

> **【要確認】** `m_guardian.phone_number` は要件定義書に明示的な根拠がない。4-2 (2) は緊急連絡の経路を「園から保護者への電話（**園児マスターの連絡先による**）」としているが、4-1-3 の園児マスターの登録項目に連絡先（電話番号）が存在しない。一方 4-1-1 は「保護者のメールアドレスは……**園からの緊急時の連絡先**として保持する」としており、2か所で連絡先の所在が食い違っている。本図では保護者に電話番号を持たせる形で仮置きした。要件定義書側での確定を要する（下記 6-1 No.1）。

## 2-2 園児・クラス

```mermaid
erDiagram
    m_child ||--o{ t_guardian_child : "紐づく保護者"
    m_guardian ||--o{ t_guardian_child : "紐づく園児"
    m_class ||--o{ t_class_child : "在籍"
    m_child ||--o{ t_class_child : "所属"
    m_class ||--o{ t_class_staff : "担任"
    m_staff ||--o{ t_class_staff : "担任クラス"
    m_child ||--o{ m_allergy : "アレルギー"
    m_child ||--o{ m_medical_history : "既往歴"

    m_child {
        varchar child_id PK "園児ID"
        varchar child_name "氏名"
        varchar child_name_kana "氏名かな"
        date birth_date "生年月日。月齢計算の単一の根拠"
        char sex "1:男 2:女 9:未回答"
        decimal normal_temperature "平熱"
        char enrollment_status "1:在籍 2:退園 3:卒園"
        char photo_consent_level "1:園内記録 2:自児保護者へ共有 3:他保護者にも見える場"
        boolean is_deleted "誤登録の取消。論理削除"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    m_class {
        bigint class_id PK "自動採番"
        int fiscal_year "年度。4月1日から翌3月31日"
        varchar class_name "クラス名"
        datetime created_at "登録日時"
    }
    t_class_child {
        bigint class_child_id PK "自動採番"
        bigint class_id FK "m_class を参照"
        varchar child_id FK "m_child を参照"
        datetime created_at "登録日時"
    }
    t_class_staff {
        bigint class_staff_id PK "自動採番"
        bigint class_id FK "m_class を参照"
        varchar staff_id FK "m_staff を参照"
        datetime created_at "登録日時"
    }
    t_guardian_child {
        bigint guardian_child_id PK "自動採番"
        varchar guardian_id FK "m_guardian を参照"
        varchar child_id FK "m_child を参照"
        varchar relationship "続柄"
        char link_status "1:有効 2:終了"
        datetime linked_at "紐づけた日時"
        datetime ended_at "紐づけを終了した日時"
    }
    m_allergy {
        bigint allergy_id PK "自動採番"
        varchar child_id FK "m_child を参照"
        varchar target_food "対象食材"
        varchar symptom "症状"
        varchar response "対応方法"
        datetime updated_at "更新日時"
    }
    m_medical_history {
        bigint medical_history_id PK "自動採番"
        varchar child_id FK "m_child を参照"
        varchar content "既往歴"
        datetime updated_at "更新日時"
    }
```

**設計上の判断**

- **クラスは年度ごとに別レコードとする**（`m_class.fiscal_year`）。年度更新は新年度の `m_class` を作成し、`t_class_child` と `t_class_staff` を新年度分として作り直す操作になる（4-1-3）。過年度の割り当てが残るため、**「過去にどのクラスの担任だったか」を後から判定できる**。
- 「自クラス」の判定は `t_class_staff`（現在年度）→ `t_class_child` → `m_child` の経路をたどる。**参照範囲は園児単位で判定する**ため、記録側の年度は判定に用いない（4-1-2）。
- **引き継ぎ猶予期間**（4-1-2）は、前年度の `t_class_staff` と、年度更新の実行日時＋猶予期間から判定する。年度更新の実行日時を保持する必要がある（下記 6-2 No.2）。
- `t_guardian_child.link_status` を「終了」にすることで退園・卒園を表す。**アカウントの停止は、有効な紐づけが1件も無くなった時点で `m_account.status` を停止に変える**（4-1-2）。
- アレルギーは1園児に複数登録できるよう別テーブルとした（対象食材ごとに症状・対応方法が異なるため）。

## 2-3 日誌

```mermaid
erDiagram
    t_diary ||--o{ t_diary_attachment : "添付"
    t_diary ||--o| t_diary_lock : "編集ロック"
    m_diary_template ||--o{ t_diary : "雛形"
    m_child ||--o{ t_diary : "対象園児"
    m_class ||--o{ t_diary : "対象クラス"
    m_staff ||--o{ t_diary : "作成・承認"

    t_diary {
        bigint diary_id PK "自動採番"
        char record_type "1:個人日誌 2:クラス日誌 3:週案月案 4:ヒヤリハット"
        varchar child_id FK "個人日誌とヒヤリハットのみ"
        bigint class_id FK "対象クラス"
        date diary_date "記録日"
        text body "本文"
        char status "1:下書き 2:申請中 3:承認済み 4:差し戻し"
        varchar created_staff_id FK "作成者"
        varchar approved_staff_id FK "承認した管理者"
        datetime approved_at "承認日時"
        boolean is_shared_to_guardian "保護者へ共有するか"
        datetime shared_at "個人チャットへ送った日時"
        bigint nap_abnormal_id FK "起票元の異常時記録。ヒヤリハットのみ"
        boolean is_deleted "論理削除"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    t_diary_attachment {
        bigint diary_attachment_id PK "自動採番"
        bigint diary_id FK "t_diary を参照"
        varchar file_path "保存先"
        char file_type "1:画像 2:動画"
        datetime created_at "登録日時"
    }
    t_diary_lock {
        bigint diary_id PK "1件の日誌に1つ"
        varchar lock_token UK "ロック取得のたびに発行する一意の識別子"
        varchar locked_staff_id FK "編集中の職員"
        datetime locked_at "取得日時"
        datetime last_active_at "最終操作時刻。無操作の判定に用いる"
    }
    m_diary_template {
        bigint diary_template_id PK "自動採番"
        char record_type "対応する記録種別"
        varchar template_name "雛形名"
        text body "雛形の本文"
        boolean default_share_to_guardian "保護者共有の既定値"
    }
```

**設計上の判断**

- **記録種別を `record_type` の区分値で持ち、テーブルは分けない。** 個人日誌・クラス日誌・週案／月案・ヒヤリハットは保持する項目がほぼ共通であり、保護者共有の既定値だけが種別によって変わるため（4-2 (1)）。
- **編集ロックは `lock_token` を保存時に照合する**（4-1-4 (3)）。管理者が強制解除するとレコードを削除するため、保存時にトークンが一致せず、**他者の更新が無くても保存が拒否される**。
- ヒヤリハットは `nap_abnormal_id` で起票元の異常時記録と相互に参照できる（4-2 (1)）。**集計はヒヤリハット側を正とする**。
- 雛形はマスタとして園が追加・変更できる（4-2 (1)）。保護者共有の既定値も雛形側に持たせ、コードに書かない（7-1 No.7）。

## 2-4 チャット

```mermaid
erDiagram
    m_chat_room ||--o{ t_chat_member : "参加者"
    m_chat_room ||--o{ t_chat_message : "メッセージ"
    m_account ||--o{ t_chat_member : "所属"
    m_account ||--o{ t_chat_message : "送信"
    t_chat_message ||--o{ t_chat_attachment : "添付"
    t_chat_message ||--o{ t_chat_read : "既読"
    t_chat_message ||--o{ t_chat_reaction : "リアクション"
    t_chat_message ||--o| t_misdelivery_record : "誤送信への対応"
    m_class ||--o{ m_chat_room : "クラスグループの連動元"

    m_chat_room {
        bigint chat_room_id PK "自動採番"
        char room_type "1:園 2:クラスグループ 3:目的別グループ 4:個人 5:職員"
        bigint class_id FK "クラスグループのみ。クラスと年度で自動構成"
        varchar room_name "表示名"
        boolean is_archived "過年度のクラスグループ。投稿不可"
        char thread_status "個人チャットのみ 1:未対応 2:対応済み"
        datetime created_at "作成日時"
    }
    t_chat_member {
        bigint chat_member_id PK "自動採番"
        bigint chat_room_id FK "m_chat_room を参照"
        bigint account_id FK "m_account を参照"
        datetime joined_at "参加日時"
        datetime left_at "退出日時。過去ログの参照範囲の判定に用いる"
    }
    t_chat_message {
        bigint chat_message_id PK "自動採番"
        bigint chat_room_id FK "m_chat_room を参照"
        bigint sender_account_id FK "送信者"
        text body "本文"
        char source_type "1:手入力 2:日誌の共有 3:発達身体測定の共有"
        bigint source_id "共有元のレコードID"
        datetime sent_at "送信日時"
        datetime edited_at "編集日時"
        boolean is_deleted "送信取消と管理者削除。論理削除"
        datetime deleted_at "削除日時"
        bigint deleted_account_id FK "削除した者"
    }
    t_chat_attachment {
        bigint chat_attachment_id PK "自動採番"
        bigint chat_message_id FK "t_chat_message を参照"
        varchar file_path "保存先"
        char file_type "1:画像 2:動画"
        bigint file_size "上限はマスタ値"
    }
    t_chat_read {
        bigint chat_read_id PK "自動採番"
        bigint chat_message_id FK "t_chat_message を参照"
        bigint account_id FK "閲覧した者"
        datetime read_at "既読日時"
    }
    t_chat_reaction {
        bigint chat_reaction_id PK "自動採番"
        bigint chat_message_id FK "t_chat_message を参照"
        bigint account_id FK "付与した者"
        char reaction_type "種別"
    }
    t_misdelivery_record {
        bigint misdelivery_record_id PK "自動採番"
        bigint chat_message_id FK "誤送信したメッセージ"
        datetime occurred_at "発生日時"
        boolean was_read "既読になっていたか"
        text response "とった対応"
        varchar staff_id FK "記録した管理者"
        datetime created_at "登録日時"
    }
```

**設計上の判断**

- **過去ログの参照範囲は `t_chat_member` で判定する**（4-2 (2) (c)）。園児単位ではなく「そのグループにメンバーとして所属していたか」で判定するため、`left_at` を保持して**過去に所属していた期間**を追えるようにした。
- 職員は `left_at` が入っていても参照できる。**保護者は `left_at` が入った時点で参照できなくなる**（現在所属しているグループのみ）。退園・卒園により紐づけが終了した時点で `left_at` を設定する。
- クラスグループは `class_id` を持ち、`m_class` が年度ごとに別レコードであるため、**年度が変わると別のチャットルームになる**。過年度分は `is_archived` を立てて投稿不可のアーカイブとして残す。
- **日誌・発達チェックからの共有は `t_chat_message` のレコードとして表す**（`source_type` / `source_id`）。保護者向けの表示は共有可のフラグが立った項目のみを本文に含めた状態で生成するため、チャット側に共有可否の判定を持たせない。
- `thread_status` は個人チャットのスレッド単位の状態（4-2 (2)）。**保護者の画面には表示しない**。

## 2-5 午睡チェック

```mermaid
erDiagram
    t_nap_session ||--o{ t_nap_record : "チェック記録"
    t_nap_session ||--o{ t_nap_abnormal : "異常時の記録"
    m_class ||--o{ t_nap_session : "対象クラス"
    m_child ||--o{ t_nap_record : "対象園児"
    m_child ||--o{ t_nap_abnormal : "対象園児"
    m_staff ||--o{ t_nap_record : "記録者"

    t_nap_session {
        bigint nap_session_id PK "自動採番"
        bigint class_id FK "m_class を参照"
        date session_date "実施日"
        varchar started_staff_id FK "開始操作を行った職員"
        datetime started_at "午睡チェックを開始した時刻"
        varchar ended_staff_id FK "終了操作を行った職員"
        datetime ended_at "終了時刻。未設定なら実施中"
        boolean is_auto_closed "午睡の時間帯の終了で自動解除されたか"
    }
    t_nap_record {
        bigint nap_record_id PK "自動採番"
        bigint nap_session_id FK "t_nap_session を参照"
        varchar child_id FK "m_child を参照"
        datetime checked_at "保育士が入力したチェックを行った時刻"
        datetime saved_at "サーバ時刻での保存時刻"
        char body_position "1:仰向け 2:うつ伏せ 3:左向き 4:右向き"
        char breathing "1:あり 2:確認できず"
        char complexion "1:通常 2:蒼白 3:紅潮 4:その他"
        decimal temperature "体温。必須とするタイミングはマスタ値"
        varchar staff_id FK "記録した職員"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    t_nap_abnormal {
        bigint nap_abnormal_id PK "自動採番"
        bigint nap_session_id FK "t_nap_session を参照"
        varchar child_id FK "m_child を参照"
        datetime found_at "発見時刻"
        text situation "状況"
        text response "とった対応"
        varchar staff_id FK "記録した職員"
        bigint diary_id FK "起票したヒヤリハット。未起票なら空"
        datetime created_at "登録日時"
    }
```

**設計上の判断**

- **`t_nap_session` は、午睡チェックの「開始する／終了する」操作を保持するために設けた**（4-1-4 (4)）。自動ログアウトの例外の適用範囲がこのレコードで決まるほか、**誰がどの時間帯の午睡チェックを担当したか**を追跡できる。
- `checked_at` と `saved_at` を**両方保持する**（4-2 (3)）。後追い入力を許容しつつ、帳票に両方を出力して監査に耐えるようにするため。両者の乖離は一括確認画面で識別する。
- **`t_nap_record` に削除フラグを持たせない。** 保存済み記録の削除は行わず、誤記録は修正で対応する方針のため（4-2 (3)）。修正履歴は共通操作ログが保持する。
- `t_nap_abnormal.diary_id` が空のレコードが「異常を記録したがヒヤリハットを起票していない」状態を表す。**システムは起票の要否を判定しない**（4-2 (1)）。

## 2-6 発達チェック・身体測定

```mermaid
erDiagram
    m_development_category ||--o{ m_development_item : "区分に属する項目"
    m_development_item ||--o{ t_development_result : "チェック結果"
    t_development_check ||--o{ t_development_result : "1回のチェック"
    m_child ||--o{ t_development_check : "対象園児"
    m_child ||--o{ t_development_schedule : "実施予定"
    m_child ||--o{ t_physical_record : "身体測定"
    m_development_item ||--o| m_share_setting : "共有可否"
    m_growth_standard }o..o{ t_physical_record : "性別と月齢で参照"

    m_development_category {
        bigint development_category_id PK "自動採番"
        int age_month_from "適用開始月齢"
        int age_month_to "適用終了月齢"
        varchar category_name "発達過程区分名"
        int display_order "表示順"
    }
    m_development_item {
        bigint development_item_id PK "自動採番"
        bigint development_category_id FK "m_development_category を参照"
        varchar item_name "チェック項目"
        char domain "3歳以上の5領域 1:健康 2:人間関係 3:環境 4:言葉 5:表現"
        int display_order "表示順"
    }
    m_share_setting {
        bigint share_setting_id PK "自動採番"
        bigint development_item_id FK "m_development_item を参照。一意"
        boolean is_shareable "共有可否。園内限定なら偽"
        varchar updated_staff_id FK "設定した管理者"
        datetime updated_at "更新日時"
    }
    m_development_frequency {
        bigint development_frequency_id PK "自動採番"
        int age_month_from "適用開始月齢"
        int age_month_to "適用終了月齢"
        int interval_days "推奨するチェック間隔"
    }
    t_development_schedule {
        bigint development_schedule_id PK "自動採番"
        varchar child_id FK "m_child を参照"
        date scheduled_on "実施予定日"
        boolean is_manual_override "推奨からの手動上書きか"
        varchar created_staff_id FK "設定した者"
        datetime created_at "登録日時"
    }
    t_development_check {
        bigint development_check_id PK "自動採番"
        varchar child_id FK "m_child を参照"
        bigint development_schedule_id FK "対応する予定"
        date checked_on "実施日"
        char status "1:下書き 2:確定"
        varchar staff_id FK "実施した職員"
        char share_status "0:対象外 1:未連携 2:連携済"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    t_development_result {
        bigint development_result_id PK "自動採番"
        bigint development_check_id FK "t_development_check を参照"
        bigint development_item_id FK "m_development_item を参照"
        char result "1:確認できた 2:一部 3:未確認"
        text note "所見"
    }
    t_physical_record {
        bigint physical_record_id PK "自動採番"
        varchar child_id FK "m_child を参照"
        date measured_on "測定日"
        decimal height_cm "身長"
        decimal weight_kg "体重"
        varchar staff_id FK "初回登録者"
        char share_status "0:対象外 1:未連携 2:連携済"
        boolean is_deleted "論理削除"
        datetime created_at "登録日時"
        datetime updated_at "更新日時"
    }
    m_growth_standard {
        bigint growth_standard_id PK "自動採番"
        char sex "1:男 2:女。未回答に対応する基準値は持たない"
        int age_in_months "月齢 0から72"
        char measure_type "1:身長 2:体重"
        int percentile "3 10 25 50 75 90 97"
        decimal standard_value "基準値"
        varchar source_version "出典版"
    }
```

**設計上の判断**

- **「未入力」は `t_development_result` にレコードが存在しない状態で表す。** 「未確認」は `result = 3` として明示的に保持する。両者は別の状態であり、チェック漏れの判定対象になるのは「未入力」のみ（4-2 (4)）。
- チェック項目・発達過程区分・推奨頻度をすべてマスタ化し、**保育所保育指針の改定にコード変更なしで追従する**（7-1 No.7）。
- `t_physical_record` と `m_growth_standard` は `基本設計書（身体記録のみ）.md` 第3.0版の定義をそのまま用いる。**`m_growth_standard` は男女のみを保持し、`m_child.sex = 9`（未回答）の園児には基準値の帯を描画しない**（4-1-3）。
- `t_development_check.share_status` は `t_physical_record.share_status` と同じ区分値とし、未連携記録の抽出と再連携に用いる。

# 3 共通エリア

```mermaid
erDiagram
    m_account ||--o{ t_operation_log : "操作者"
    m_child ||--o{ t_operation_log : "対象園児"

    t_operation_log {
        bigint operation_log_id PK "自動採番"
        bigint account_id FK "操作者"
        datetime operated_at "サーバ時刻"
        char function_type "1:日誌 2:チャット 3:午睡 4:発達 5:身体測定 6:園児 7:アカウント"
        char operation_type "1:作成 2:変更 3:承認 4:削除 5:出力"
        varchar target_table "対象テーブルの物理名"
        bigint target_id "対象レコードのID"
        varchar target_child_id FK "絞り込み用。対象が園児に紐づく場合"
        text before_value "変更前の値"
        text after_value "変更後の値"
    }
    m_setting {
        varchar setting_key PK "例 nap.interval_minutes"
        varchar setting_value "文字列で保持し利用側で型変換する"
        varchar description "設定画面での表示用"
        varchar updated_staff_id FK "更新した者"
        datetime updated_at "更新日時"
    }
```

- **操作ログは追記のみとし、更新・削除の手段を設けない**（4-1-4 (2)）。`updated_at` を持たないのはこのため。
- `before_value` / `after_value` を保持することで、午睡チェックの修正履歴（4-2 (3)）と身体測定の更新履歴を共通操作ログに統合できる（基本設計書 5-4 の方針）。
- `m_setting` に保持する主なマスタ値は次のとおり。**いずれもコードに直接書かない**（7-1 No.7）。

| 分類 | 保持する値 | 典拠 |
| :-- | :-- | :-- |
| 午睡チェック | チェック間隔（年齢別）、体温の必須タイミング、午睡の時間帯 | 4-2 (3)、4-1-4 (4) |
| 認証 | ログイン失敗回数、待機時間、ログイン情報の記憶の保存期間、一時パスワードの有効期限 | 4-1-1 |
| 画面 | 職員向け画面の自動ログアウトまでの無操作時間、日誌の編集ロックの無操作時間 | 4-1-4 (3)(4) |
| 参照範囲 | 年度更新に伴う引き継ぎ猶予期間、年度更新の実行日時 | 4-1-2 |
| 添付 | 対応形式、1ファイルあたりの上限サイズ | 4-2 (2) |
| データ保持 | 記録の保持年数、添付ファイルの保持期間 | 7-3 |

# 4 要件定義書との対応

| 要件定義書の節 | 対応するエンティティ |
| :-- | :-- |
| 4-1-1 アプリのログイン | `m_account`、`m_terms` |
| 4-1-2 アカウントの管理 | `m_account`、`m_staff`、`m_guardian`、`t_invitation_code`、`t_guardian_child`、`m_class`、`t_class_staff` |
| 4-1-3 園児マスターの管理 | `m_child`、`t_class_child`、`m_allergy`、`m_medical_history` |
| 4-1-4 全機能に共通する扱い | `t_operation_log`、`t_diary_lock`、`t_nap_session`、`m_setting` |
| 4-2 (1) 日誌システム | `t_diary`、`t_diary_attachment`、`m_diary_template` |
| 4-2 (2) チャットツール | `m_chat_room`、`t_chat_member`、`t_chat_message`、`t_chat_read`、`t_chat_reaction`、`t_chat_attachment`、`t_misdelivery_record` |
| 4-2 (3) 午睡チェック | `t_nap_session`、`t_nap_record`、`t_nap_abnormal` |
| 4-2 (4) 発達チェック | `m_development_category`、`m_development_item`、`m_development_frequency`、`t_development_schedule`、`t_development_check`、`t_development_result`、`m_share_setting`、`t_physical_record`、`m_growth_standard` |

# 5 参照範囲の判定経路

権限チェックはサーバ側で強制する（8 セキュリティ要求 No.2）。判定に用いる経路を示す。

| 判定 | 経路 |
| :-- | :-- |
| 一般が園児を参照できるか（通常） | `m_account` → `m_staff` → `t_class_staff`（現在年度の `m_class`）→ `t_class_child` → `m_child` |
| 一般が園児を参照できるか（猶予期間中） | 上記に加え、`t_class_staff`（前年度の `m_class`）→ `t_class_child`。年度更新の実行日時＋猶予期間内であり、かつ**閲覧のみ** |
| 保護者が園児を参照できるか | `m_account` → `m_guardian` → `t_guardian_child`（`link_status = 1`）→ `m_child` |
| アレルギー情報の参照（例外①） | クラスによる絞り込みを行わない。一般も全園児を閲覧できる（8 No.6 の例外） |
| チャット過去ログの参照（例外②） | `t_chat_member` による。職員は `left_at` が入っていても可、保護者は現在所属しているルームのみ（8 No.6 の例外） |

# 6 要確認・要決定事項

## 6-1 要件定義書側での確定を要する事項

| No | 内容 |
| :-: | :-- |
| 1 | **保護者の電話番号の保持先が定義されていない。** 4-2 (2) は緊急連絡を「園から保護者への電話（園児マスターの連絡先による）」としているが、4-1-3 の園児マスターに連絡先の項目がない。一方 4-1-1 は保護者のメールアドレスを緊急時の連絡先としている。緊急連絡を電話に一本化した以上、電話番号を保持する場所（保護者アカウント／園児マスター）と、複数の保護者がいる場合の連絡順を要件定義書で確定する必要がある |
| 2 | 職員チャット（`room_type = 5`）の位置づけ。4-2 (2) の権限表に「職員チャット」があるが、グループチャットとの違い（全職員が自動的に参加するのか、任意編成か）が本文に記述されていない |

## 6-2 基本設計で確定する事項

| No | 内容 |
| :-: | :-- |
| 1 | 利用規約の同意履歴を、アカウントの最新版のみ保持するか（`m_account.terms_version`）、履歴テーブル（`t_terms_agreement`）を設けるか |
| 2 | 年度更新の実行日時の保持先。引き継ぎ猶予期間の判定に必要となる（`m_setting` に持たせるか、年度更新の実行履歴テーブルを設けるか） |
| 3 | 添付ファイルの実体の保存先（データベース内か、ファイルシステム上か）。`file_path` の解釈が変わる |
| 4 | 個人チャットのルームを保護者アカウント単位で作るか、園児単位で作るか。兄弟姉妹がいる場合にスレッドを分けるかで変わる |
| 5 | `t_operation_log` の `before_value` / `after_value` の保持形式（JSON か、項目名と値の組を別テーブルに正規化するか） |
| 6 | 論理削除した記録に対する一意制約の扱い。`t_physical_record` では部分一意インデックスで解決済み（基本設計書 5-1）。同種の制約が必要なテーブル（`t_class_child`、`m_share_setting` など）を洗い出す |
