-- すくすくシステム スキーマ定義（SQLite）
--
-- 典拠：基本設計書.md「データベース設計」(5)
--
-- 命名・型・制約は同章の定義に従う。
--   マスタは m_、トランザクションは t_ を接頭辞とする
--   代理キーは BIGINT の自動採番。列名は <主語>_id
--   業務ID（園児ID・職員ID・保護者ID）は VARCHAR(20)
--   削除は論理削除（is_deleted）。削除者・削除日時は共通操作ログが保持する
--   時刻列は created_at / updated_at。サーバの時刻を入れる
--   区分値は CHAR(1) の数字コード
--
-- SQLite を選ぶ理由：t_physical_record の部分一意インデックスに対応するため
-- （基本設計書 5-7。MySQL は非対応）。

PRAGMA foreign_keys = ON;

-- ============ 5-2 アカウント・権限 ============

-- アカウント（m_account）
-- 認証情報を1つの表に集約する。ログインIDはロールをまたいで園内で一意でなければならず、
-- 職員表・保護者表に分けて持つとデータベースの制約で担保できないため。
CREATE TABLE m_account (
  account_id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email                    TEXT    NOT NULL UNIQUE,
  password_hash            TEXT    NOT NULL,
  role                     TEXT    NOT NULL CHECK (role IN ('1','2','3')),      -- 1:管理者 2:一般 3:保護者
  status                   TEXT    NOT NULL CHECK (status IN ('1','2')),        -- 1:有効 2:停止
  is_temp_password         INTEGER NOT NULL DEFAULT 0,
  temp_password_expires_at TEXT,
  failed_login_count       INTEGER NOT NULL DEFAULT 0,
  locked_until             TEXT,
  terms_version            TEXT,
  terms_agreed_at          TEXT,
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL
);

-- 職員（m_staff）
CREATE TABLE m_staff (
  staff_id   TEXT    PRIMARY KEY,
  account_id INTEGER NOT NULL UNIQUE REFERENCES m_account(account_id),
  staff_name TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

-- 保護者（m_guardian）
CREATE TABLE m_guardian (
  guardian_id   TEXT    PRIMARY KEY,
  account_id    INTEGER NOT NULL UNIQUE REFERENCES m_account(account_id),
  guardian_name TEXT    NOT NULL,
  phone_number  TEXT,   -- 緊急連絡先。保持先が未確定（基本設計書「要決定事項」(7) No.1）
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- 招待コード（t_invitation_code）
-- 1枚のコードは1アカウントの登録にのみ使える。使用と同時に status を使用済みにする。
CREATE TABLE t_invitation_code (
  invitation_code_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT    NOT NULL UNIQUE,
  child_id           TEXT    NOT NULL REFERENCES m_child(child_id),
  expires_on         TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('1','2','3')),  -- 1:未使用 2:使用済 3:失効
  used_account_id    INTEGER REFERENCES m_account(account_id),
  used_at            TEXT,
  issued_staff_id    TEXT    NOT NULL REFERENCES m_staff(staff_id),
  created_at         TEXT    NOT NULL
);

-- 利用規約（m_terms）
CREATE TABLE m_terms (
  terms_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  terms_version TEXT    NOT NULL,
  document_type TEXT    NOT NULL CHECK (document_type IN ('1','2')),  -- 1:利用規約 2:プライバシーポリシー
  body          TEXT    NOT NULL,
  published_on  TEXT    NOT NULL,
  covers_external_ai INTEGER NOT NULL DEFAULT 0,
  UNIQUE (terms_version, document_type)
);

-- 同意履歴（t_terms_agreement）。追記のみとし、更新・削除の手段を設けない。
-- アカウントの terms_version は「再同意が必要か」を判定する現在値であり、履歴とは役割が違う。
-- 既存のデータベースには db.go の ensureTermsAgreement が同じ定義で作る。片方だけ直さないこと
CREATE TABLE t_terms_agreement (
  terms_agreement_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id         INTEGER NOT NULL REFERENCES m_account(account_id),
  terms_id           INTEGER NOT NULL REFERENCES m_terms(terms_id),
  agreed_at          TEXT    NOT NULL
);

-- ============ 5-3 園児・クラス ============

-- 園児（m_child）
CREATE TABLE m_child (
  child_id            TEXT    PRIMARY KEY,
  child_name          TEXT    NOT NULL,
  child_name_kana     TEXT,
  -- 月齢算出の唯一の根拠。未来日不可
  birth_date          TEXT    NOT NULL,
  sex                 TEXT    NOT NULL CHECK (sex IN ('1','2','9')),                    -- 1:男 2:女 9:未回答
  normal_temperature  REAL,
  enrollment_status   TEXT    NOT NULL CHECK (enrollment_status IN ('1','2','3')),      -- 1:在籍 2:退園 3:卒園
  photo_consent_level TEXT    NOT NULL CHECK (photo_consent_level IN ('1','2','3')),    -- 1:園内記録 2:自児保護者 3:他保護者
  -- 詳細設計書「変える表」(5-3)。既存の DB には db_contact.go の ensureContactSchema が同じ定義で足す
  nickname             TEXT,                                                              -- 呼び名
  face_photo_path      TEXT,
  withdrawn_on         TEXT,
  nap_interval_minutes INTEGER CHECK (nap_interval_minutes BETWEEN 1 AND 15),
  is_deleted          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

-- クラス（m_class）。年度ごとに別レコードとし、過年度の割り当てを残す
CREATE TABLE m_class (
  class_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  fiscal_year INTEGER NOT NULL,
  class_name  TEXT    NOT NULL,
  -- 年齢児（0:0歳児 … 5:5歳児）。午睡チェックの間隔を引く（基本設計書「クラスと紐づけ」(5-3)）。
  -- 既存のデータベースには db.go の ensureDesignColumns が同じ定義で足す
  age_class   INTEGER NOT NULL DEFAULT 2 CHECK (age_class BETWEEN 0 AND 5),
  UNIQUE (fiscal_year, class_name)
);

CREATE TABLE t_class_child (
  class_id INTEGER NOT NULL REFERENCES m_class(class_id),
  child_id TEXT    NOT NULL REFERENCES m_child(child_id),
  PRIMARY KEY (class_id, child_id)
);

CREATE TABLE t_class_staff (
  class_id INTEGER NOT NULL REFERENCES m_class(class_id),
  staff_id TEXT    NOT NULL REFERENCES m_staff(staff_id),
  PRIMARY KEY (class_id, staff_id)
);

-- 園児と保護者の紐づけ（t_guardian_child）
-- 紐づけ単位で終了させる。アカウントの停止は有効な紐づけがゼロになった時点。
CREATE TABLE t_guardian_child (
  guardian_id  TEXT NOT NULL REFERENCES m_guardian(guardian_id),
  child_id     TEXT NOT NULL REFERENCES m_child(child_id),
  relationship TEXT,
  link_status  TEXT NOT NULL CHECK (link_status IN ('1','2','3')),  -- 1:有効 2:終了 3:猶予中
  linked_at    TEXT NOT NULL,
  ended_at     TEXT,
  grace_ends_on TEXT,
  ai_opt_out INTEGER NOT NULL DEFAULT 0,
  contact_order INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (guardian_id, child_id)
);

-- アレルギー（m_allergy）。1園児に複数登録できる。要配慮個人情報
CREATE TABLE m_allergy (
  allergy_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id    TEXT    NOT NULL REFERENCES m_child(child_id),
  target_food TEXT    NOT NULL,
  symptom     TEXT,
  response    TEXT
);

-- 既往歴（m_medical_history）。要配慮個人情報
CREATE TABLE m_medical_history (
  medical_history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id           TEXT    NOT NULL REFERENCES m_child(child_id),
  content            TEXT    NOT NULL
);

-- ============ 5-4 日誌 ============

-- 日誌（t_diary）。記録種別でテーブルを分けない。園内の記録で、どの状態でも保護者には届かない
-- （基本設計書「日誌システム（園内の記録）」(4-6)、詳細設計書「変える表」(5-3)）。
-- 既存の DB は db_diary.go の ensureInternalDiary が同じ定義に作り直す（定義は2か所で同じにする）
CREATE TABLE t_diary (
  diary_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type           TEXT    NOT NULL CHECK (record_type IN ('1','2','3','4')),  -- 1:個人 2:クラス 3:週案月案 4:ヒヤリハット
  child_id              TEXT    REFERENCES m_child(child_id),
  class_id              INTEGER NOT NULL REFERENCES m_class(class_id),
  diary_date            TEXT    NOT NULL,
  body                  TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('1','2','3','4')),       -- 1:下書き 2:申請中 3:承認済み 4:差し戻し
  created_staff_id      TEXT    NOT NULL REFERENCES m_staff(staff_id),
  -- 申請した職員と日時。取り下げると空になる。「自分が申請した日誌は承認できない」はこの列で判定する
  applied_staff_id      TEXT    REFERENCES m_staff(staff_id),
  applied_at            TEXT,
  -- 承認した職員と日時。差し戻しでは書かない。承認を取り消すと空になる（詳細設計書「日誌の状態」(3-6)）
  approved_staff_id     TEXT    REFERENCES m_staff(staff_id),
  approved_at           TEXT,
  -- ヒヤリハットの欄（発生日時・場所・保護者へ伝えたこと）。状況・とった対応は本文に見出しを付けて持つ
  occurred_at           TEXT,
  place                 TEXT,
  guardian_notice       TEXT    CHECK (guardian_notice IN ('1','2')),                 -- 1:伝えた 2:伝えていない
  guardian_noticed_at   TEXT,
  guardian_notice_method TEXT   CHECK (guardian_notice_method IN ('1','2','3','9')),  -- 1:電話 2:お迎えのとき 3:連絡帳・個人チャット 9:その他
  guardian_notice_person TEXT,
  -- 起票元。ヒヤリハットのみ。異常時の記録と相互に参照する
  nap_abnormal_id       INTEGER REFERENCES t_nap_abnormal(nap_abnormal_id),
  -- 差し戻す理由。差し戻しは理由の入力を必須とする（画面詳細図 3-3）
  returned_reason       TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  -- 日付の前後を比べる CHECK は置かない（日付ずらしが列を1つずつ書き換えるため。詳細設計書の決めたこと D-25）
  CHECK (status NOT IN ('2','3') OR (applied_staff_id IS NOT NULL AND applied_at IS NOT NULL)),
  CHECK (record_type <> '4' OR (occurred_at IS NOT NULL AND place IS NOT NULL)),
  CHECK (guardian_notice IS NOT '1' OR (guardian_noticed_at IS NOT NULL AND guardian_notice_method IS NOT NULL AND guardian_notice_person IS NOT NULL))
);
CREATE INDEX ix_diary_date   ON t_diary (diary_date);
CREATE INDEX ix_diary_child  ON t_diary (child_id, diary_date);
CREATE INDEX ix_diary_class  ON t_diary (class_id, diary_date);
CREATE INDEX ix_diary_status ON t_diary (status, applied_at);

-- 編集ロック（t_diary_lock）。取得のたびにトークンを発行し、保存時に照合する
CREATE TABLE t_diary_lock (
  diary_id        INTEGER PRIMARY KEY REFERENCES t_diary(diary_id),
  lock_token      TEXT    NOT NULL UNIQUE,
  locked_staff_id TEXT    NOT NULL REFERENCES m_staff(staff_id),
  locked_at       TEXT    NOT NULL,
  last_active_at  TEXT    NOT NULL
);

-- 雛形（m_diary_template）。保護者への共有の既定は持たない（日誌は共有しない。詳細設計書「変える表」(5-3)）
CREATE TABLE m_diary_template (
  diary_template_id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type       TEXT    NOT NULL CHECK (record_type IN ('1','2','3','4')),
  template_name     TEXT    NOT NULL,
  body              TEXT    NOT NULL,
  is_deleted        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE t_diary_attachment (
  diary_attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  diary_id            INTEGER NOT NULL REFERENCES t_diary(diary_id),
  file_path           TEXT    NOT NULL,
  file_type           TEXT    NOT NULL
);

-- ============ 5-5 チャット ============

CREATE TABLE m_chat_room (
  chat_room_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  room_type     TEXT    NOT NULL CHECK (room_type IN ('1','2','3','4','5')),  -- 1:園 2:クラス 3:目的別 4:個人 5:職員
  class_id      INTEGER REFERENCES m_class(class_id),
  room_name     TEXT    NOT NULL,
  is_archived   INTEGER NOT NULL DEFAULT 0,
  thread_status TEXT,                                                       -- 個人チャットのみ 1:未対応 2:対応済み
  -- 個人チャットの園児。個人チャットのルームは園児単位で作る（基本設計書 5-5）。
  -- 【仮置き】設計の列定義（5-5）に無い列。氏名の文字列で部屋を探すと、同じ氏名の別の園児の
  -- 部屋に入るため、園児ID で結ぶ（GitHub Issue #163。web/仮置き値.md）
  child_id      TEXT    REFERENCES m_child(child_id)
);
-- 1人の園児に個人チャットは1つ
CREATE UNIQUE INDEX ux_chat_room_child ON m_chat_room (child_id) WHERE room_type = '4';

-- 参加者（t_chat_member）。left_at で過去の所属期間を保持する。
-- 職員は left_at が入っていても参照できる。保護者は入った時点で参照できなくなる。
CREATE TABLE t_chat_member (
  chat_room_id INTEGER NOT NULL REFERENCES m_chat_room(chat_room_id),
  account_id   INTEGER NOT NULL REFERENCES m_account(account_id),
  joined_at    TEXT    NOT NULL,
  left_at      TEXT,
  PRIMARY KEY (chat_room_id, account_id)
);

CREATE TABLE t_chat_message (
  chat_message_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_room_id       INTEGER NOT NULL REFERENCES m_chat_room(chat_room_id),
  sender_account_id  INTEGER NOT NULL REFERENCES m_account(account_id),
  body               TEXT    NOT NULL,
  source_type        TEXT    NOT NULL CHECK (source_type IN ('1','2','3','4')),  -- 1:手入力 2:日誌の共有 3:発達身体測定の共有 4:配布物の掲載
  source_id          INTEGER,
  sent_at            TEXT    NOT NULL,
  edited_at          TEXT,
  is_deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at         TEXT,
  deleted_account_id INTEGER REFERENCES m_account(account_id),
  -- 詳細設計書「変える表」(5-3)。既存の DB には ensureContactSchema が足す
  confirmed_staff_id TEXT,
  confirmed_at       TEXT,
  quote_message_id   INTEGER,
  quote_contact_date TEXT
);
CREATE INDEX ix_chat_message_room ON t_chat_message (chat_room_id, sent_at);

CREATE TABLE t_chat_attachment (
  chat_attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_message_id    INTEGER NOT NULL REFERENCES t_chat_message(chat_message_id),
  file_path          TEXT    NOT NULL,
  file_type          TEXT    NOT NULL,
  file_size          INTEGER NOT NULL
);

-- 既読（t_chat_read）。保護者側には表示しない
CREATE TABLE t_chat_read (
  chat_read_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_message_id INTEGER NOT NULL REFERENCES t_chat_message(chat_message_id),
  account_id      INTEGER NOT NULL REFERENCES m_account(account_id),
  read_at         TEXT    NOT NULL,
  UNIQUE (chat_message_id, account_id)
);

CREATE TABLE t_chat_reaction (
  chat_reaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_message_id  INTEGER NOT NULL REFERENCES t_chat_message(chat_message_id),
  account_id       INTEGER NOT NULL REFERENCES m_account(account_id),
  reaction_type    TEXT    NOT NULL,
  UNIQUE (chat_message_id, account_id, reaction_type)
);

CREATE TABLE t_misdelivery_record (
  misdelivery_record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_message_id       INTEGER NOT NULL REFERENCES t_chat_message(chat_message_id),
  occurred_at           TEXT    NOT NULL,
  was_read              INTEGER NOT NULL,
  response              TEXT    NOT NULL,
  staff_id              TEXT    NOT NULL REFERENCES m_staff(staff_id)
);

-- 配布物（t_handout）。園だより・献立表など、保護者があとから見返すもの。
-- 取り下げは論理削除とする。既存のデータベースには db.go の ensureHandouts が同じ定義で作る
CREATE TABLE t_handout (
  handout_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  handout_type     TEXT    NOT NULL CHECK (handout_type IN ('1','2','3','4','5')),  -- 1:園だより 2:献立表 3:行事のお知らせ 4:クラスだより 5:その他
  title            TEXT    NOT NULL,
  target_month     TEXT    NOT NULL,                                               -- 対象の月 'YYYY-MM'
  class_id         INTEGER REFERENCES m_class(class_id),                           -- 空なら園全体
  file_name        TEXT    NOT NULL,
  file_path        TEXT    NOT NULL,
  file_type        TEXT    NOT NULL,
  file_size        INTEGER NOT NULL,
  posted_staff_id  TEXT    NOT NULL REFERENCES m_staff(staff_id),
  posted_at        TEXT    NOT NULL,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT,
  deleted_staff_id TEXT    REFERENCES m_staff(staff_id)
);
CREATE INDEX ix_handout_month ON t_handout (target_month, posted_at);

-- ============ 5-6 午睡チェック ============

-- 開始・終了の操作を保持する。自動ログアウトの例外範囲と担当者の追跡に用いる
CREATE TABLE t_nap_session (
  nap_session_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id         INTEGER NOT NULL REFERENCES m_class(class_id),
  session_date     TEXT    NOT NULL,
  started_staff_id TEXT    NOT NULL REFERENCES m_staff(staff_id),
  started_at       TEXT    NOT NULL,
  ended_staff_id   TEXT    REFERENCES m_staff(staff_id),
  ended_at         TEXT,
  is_auto_closed   INTEGER NOT NULL DEFAULT 0
);

-- チェック時刻と保存時刻の両方を保持する。削除フラグは持たない（削除しないため）
CREATE TABLE t_nap_record (
  nap_record_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  nap_session_id INTEGER NOT NULL REFERENCES t_nap_session(nap_session_id),
  child_id       TEXT    NOT NULL REFERENCES m_child(child_id),
  checked_at     TEXT    NOT NULL,
  saved_at       TEXT    NOT NULL,
  body_position  TEXT    NOT NULL CHECK (body_position IN ('1','2','3','4')),  -- 1:仰向け 2:うつ伏せ 3:左向き 4:右向き
  breathing      TEXT    NOT NULL CHECK (breathing IN ('1','2')),              -- 1:あり 2:確認できず
  complexion     TEXT    NOT NULL CHECK (complexion IN ('1','2','3','4')),     -- 1:通常 2:蒼白 3:紅潮 4:その他
  temperature    REAL,
  staff_id       TEXT    NOT NULL REFERENCES m_staff(staff_id)
);
CREATE INDEX ix_nap_record_child ON t_nap_record (child_id, checked_at);

-- diary_id が空なら「記録したがヒヤリハットを起票していない」状態
CREATE TABLE t_nap_abnormal (
  nap_abnormal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  nap_session_id  INTEGER NOT NULL REFERENCES t_nap_session(nap_session_id),
  child_id        TEXT    NOT NULL REFERENCES m_child(child_id),
  found_at        TEXT    NOT NULL,
  recorded_at     TEXT,
  situation       TEXT    NOT NULL,
  response        TEXT    NOT NULL,
  staff_id        TEXT    NOT NULL REFERENCES m_staff(staff_id),
  diary_id        INTEGER REFERENCES t_diary(diary_id)
);

-- ============ 5-7 発達チェック・身体測定 ============

CREATE TABLE m_development_category (
  development_category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  age_month_from          INTEGER NOT NULL,
  age_month_to            INTEGER NOT NULL,
  category_name           TEXT    NOT NULL,
  display_order           INTEGER NOT NULL
);

CREATE TABLE m_development_item (
  development_item_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  development_category_id INTEGER NOT NULL REFERENCES m_development_category(development_category_id),
  item_name               TEXT    NOT NULL,
  domain                  TEXT    NOT NULL,
  display_order           INTEGER NOT NULL
);

CREATE TABLE m_development_frequency (
  development_frequency_id INTEGER PRIMARY KEY AUTOINCREMENT,
  age_month_from           INTEGER NOT NULL,
  age_month_to             INTEGER NOT NULL,
  interval_days            INTEGER NOT NULL
);

-- 項目単位の共有可否
CREATE TABLE m_share_setting (
  share_setting_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  development_item_id INTEGER NOT NULL UNIQUE REFERENCES m_development_item(development_item_id),
  is_shareable        INTEGER NOT NULL DEFAULT 1,
  updated_staff_id    TEXT    NOT NULL REFERENCES m_staff(staff_id),
  updated_at          TEXT    NOT NULL
);

-- 園児単位の予定。is_manual_override は手動上書き
CREATE TABLE t_development_schedule (
  development_schedule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id                TEXT    NOT NULL REFERENCES m_child(child_id),
  scheduled_on            TEXT    NOT NULL,
  is_manual_override      INTEGER NOT NULL DEFAULT 0,
  created_staff_id        TEXT    NOT NULL REFERENCES m_staff(staff_id)
);

CREATE TABLE t_development_check (
  development_check_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id                TEXT    NOT NULL REFERENCES m_child(child_id),
  development_schedule_id INTEGER REFERENCES t_development_schedule(development_schedule_id),
  checked_on              TEXT    NOT NULL,
  status                  TEXT    NOT NULL CHECK (status IN ('1','2')),          -- 1:下書き 2:確定
  staff_id                TEXT    NOT NULL REFERENCES m_staff(staff_id),
  share_status            TEXT    NOT NULL CHECK (share_status IN ('0','1','2')),
  -- 所見（チェック1件に対する自由記述）。園内限定であり、保護者へは共有しない
  -- （基本設計書「発達チェック・身体測定」(5-7)）
  note                    TEXT,
  -- 保護者へのひとこと（所見とは別の欄。確定した時点で成長の記録に届く）と、最初に確定した日時（直しても動かさない）
  -- （詳細設計書「変える表」(5-3)・「成長の記録に届くもの」(3-7)、決めたこと D-31）
  guardian_message        TEXT,
  finalized_at            TEXT,
  UNIQUE (child_id, checked_on)
);

-- 「未入力」はレコードが存在しない状態で表す。「未確認」は result='3' として保持する
CREATE TABLE t_development_result (
  development_result_id INTEGER PRIMARY KEY AUTOINCREMENT,
  development_check_id  INTEGER NOT NULL REFERENCES t_development_check(development_check_id),
  development_item_id   INTEGER NOT NULL REFERENCES m_development_item(development_item_id),
  result                TEXT    NOT NULL CHECK (result IN ('1','2','3')),  -- 1:確認できた 2:一部 3:未確認
  note                  TEXT,
  UNIQUE (development_check_id, development_item_id)
);

-- 身体測定記録（t_physical_record）
CREATE TABLE t_physical_record (
  physical_record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id           TEXT    NOT NULL REFERENCES m_child(child_id),
  measured_on        TEXT    NOT NULL,
  height_cm          REAL    NOT NULL,
  weight_kg          REAL    NOT NULL,
  -- 初回登録者。更新時に書き換えない
  staff_id           TEXT    NOT NULL REFERENCES m_staff(staff_id),
  share_status       TEXT    NOT NULL DEFAULT '1' CHECK (share_status IN ('0','1','2')),
  is_deleted         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

-- child_id + measured_on を is_deleted=0 の行のみ対象とする部分一意インデックス。
-- 削除した測定日に登録し直せるようにするため（基本設計書 5-7）。
CREATE UNIQUE INDEX ux_physical_record_alive
  ON t_physical_record (child_id, measured_on)
  WHERE is_deleted = 0;

-- 成長曲線基準値（m_growth_standard）。未回答に対応する基準値は持たない
CREATE TABLE m_growth_standard (
  growth_standard_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sex                TEXT    NOT NULL CHECK (sex IN ('1','2')),
  age_in_months      INTEGER NOT NULL CHECK (age_in_months BETWEEN 0 AND 72),
  measure_type       TEXT    NOT NULL CHECK (measure_type IN ('1','2')),  -- 1:身長 2:体重
  percentile         INTEGER NOT NULL,
  standard_value     REAL    NOT NULL,
  source_version     TEXT    NOT NULL,
  -- 手作業の転記で投入するため重複が起こりやすく、重複すると帯が二重に描画される
  UNIQUE (sex, age_in_months, measure_type, percentile)
);

-- ============ 5-8 共通 ============

-- 操作ログ（t_operation_log）。追記のみとし、更新・削除の手段を設けない。
-- updated_at を持たないのはこのため。
CREATE TABLE t_operation_log (
  operation_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 詳細設計書「変える表」(5-3)。システムの操作（operator_type = '2'）は account_id を持たない
  account_id       INTEGER REFERENCES m_account(account_id),
  operated_at      TEXT    NOT NULL,
  function_type    TEXT    NOT NULL CHECK (function_type IN ('1','2','3','4','5','6','7','8','9')),
  operation_type   TEXT    NOT NULL CHECK (operation_type IN ('1','2','3','4','5','6')),
  target_table     TEXT    NOT NULL,
  target_id        INTEGER,
  target_child_id  TEXT,
  before_value     TEXT,
  after_value      TEXT,
  operator_type    TEXT NOT NULL DEFAULT '1' CHECK (operator_type IN ('1','2')),
  CHECK (operator_type = '2' OR account_id IS NOT NULL)
);
CREATE INDEX ix_operation_log_at    ON t_operation_log (operated_at);
CREATE INDEX ix_operation_log_child ON t_operation_log (target_child_id, operated_at);

-- 設定マスタ（m_setting）。文字列で保持し、利用側で型変換する。
-- 数値として解釈できない場合は既定値へフォールバックしたうえで警告ログを出力する。
CREATE TABLE m_setting (
  setting_key      TEXT PRIMARY KEY,
  setting_value    TEXT NOT NULL,
  description      TEXT,
  updated_staff_id TEXT NOT NULL REFERENCES m_staff(staff_id),
  updated_at       TEXT NOT NULL
);

-- ============ 5-4 連絡帳（基本設計書「連絡帳」(5-4)） ============

-- 写真（t_contact_photo）。実体はファイルシステム（-files の下）。取り消したものは配信しない
CREATE TABLE t_contact_photo (
  contact_photo_id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id         INTEGER NOT NULL REFERENCES m_class(class_id),
  contact_date     TEXT    NOT NULL,
  file_path        TEXT    NOT NULL,
  file_type        TEXT    NOT NULL,
  file_size        INTEGER NOT NULL,
  staff_id         TEXT    NOT NULL REFERENCES m_staff(staff_id),
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL
);

-- 写っている子（t_contact_photo_child）。送った時点の同意を写す（なぜ送れたかを後から示す）
CREATE TABLE t_contact_photo_child (
  contact_photo_id INTEGER NOT NULL REFERENCES t_contact_photo(contact_photo_id),
  child_id         TEXT    NOT NULL REFERENCES m_child(child_id),
  consent_level    TEXT    NOT NULL CHECK (consent_level IN ('1','2','3')),
  PRIMARY KEY (contact_photo_id, child_id)
);

-- 家庭から（t_contact_home）。園児×日に1行。状態は列から読む（詳細設計書「家庭から」(3-1)）
CREATE TABLE t_contact_home (
  contact_home_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id           TEXT    NOT NULL REFERENCES m_child(child_id),
  contact_date       TEXT    NOT NULL,
  guardian_id        TEXT    NOT NULL REFERENCES m_guardian(guardian_id),   -- 最後に送った保護者
  temperature        REAL,                                                  -- 判定しない。範囲の外も保存する
  night_sleep_from   TEXT,                                                  -- 'HH:mm'
  night_sleep_to     TEXT,
  breakfast          TEXT    CHECK (breakfast IN ('1','2','3','4')),
  mood_label         TEXT,                                                  -- 選んだ時点の選択肢の文字
  pickup_type        TEXT    CHECK (pickup_type IN ('1','2')),              -- 1:いつもどおり 2:変更あり
  pickup_person      TEXT,
  pickup_time        TEXT,
  message            TEXT,
  submitted_at       TEXT    NOT NULL,
  confirmed_staff_id TEXT    REFERENCES m_staff(staff_id),
  confirmed_at       TEXT,
  revised_at         TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  UNIQUE (child_id, contact_date),
  CHECK (pickup_type IS NOT '2' OR (pickup_person IS NOT NULL AND pickup_time IS NOT NULL))
);

-- 出来事（t_contact_event）。きょうのようすの1件・園児1人。種類ごとに必須の列を縛る
CREATE TABLE t_contact_event (
  contact_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id         TEXT    NOT NULL REFERENCES m_child(child_id),          -- 届く先。参照の判定はこの列1つ
  class_id         INTEGER NOT NULL REFERENCES m_class(class_id),
  contact_date     TEXT    NOT NULL,
  event_type       TEXT    NOT NULL CHECK (event_type IN ('1','2','3','4','5')),  -- 1:食事 2:排せつ 3:体温 4:ひとこと 5:写真
  recorded_at      TEXT    NOT NULL,
  meal_kind        TEXT    CHECK (meal_kind IN ('1','2')),                  -- 1:給食 2:おやつ
  meal_amount      TEXT    CHECK (meal_amount IN ('1','2','3','4')),
  toilet_label     TEXT,                                                   -- 選んだ時点の選択肢の文字
  temperature      REAL,
  body             TEXT,
  contact_photo_id INTEGER REFERENCES t_contact_photo(contact_photo_id),
  keep_in_growth   INTEGER NOT NULL DEFAULT 0,
  staff_id         TEXT    NOT NULL REFERENCES m_staff(staff_id),          -- その日に直せる人
  corrected_at     TEXT,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  CHECK ((meal_kind IS NOT NULL AND meal_amount IS NOT NULL) = (event_type = '1')),
  CHECK ((meal_kind IS NULL) = (meal_amount IS NULL)),
  CHECK ((toilet_label IS NOT NULL) = (event_type = '2')),
  CHECK ((temperature IS NOT NULL) = (event_type = '3')),
  CHECK ((contact_photo_id IS NOT NULL) = (event_type = '5')),
  CHECK (event_type <> '4' OR body IS NOT NULL),
  CHECK (event_type NOT IN ('1','2','3') OR body IS NULL),
  CHECK (keep_in_growth = 0 OR event_type IN ('4','5'))
);
CREATE INDEX ix_contact_event_child ON t_contact_event (child_id, contact_date);
CREATE INDEX ix_contact_event_class ON t_contact_event (class_id, contact_date);
CREATE INDEX ix_contact_event_photo ON t_contact_event (contact_photo_id);

-- クラスのようす（t_contact_class）。クラスに1行。一意にしない（1日1回は目安）
CREATE TABLE t_contact_class (
  contact_class_id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id         INTEGER NOT NULL REFERENCES m_class(class_id),
  contact_date     TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  contact_photo_id INTEGER REFERENCES t_contact_photo(contact_photo_id),
  source_diary_id  INTEGER REFERENCES t_diary(diary_id),                   -- 引き写すだけで、日誌は保護者に見えない
  staff_id         TEXT    NOT NULL REFERENCES m_staff(staff_id),
  recorded_at      TEXT    NOT NULL,
  corrected_at     TEXT,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX ix_contact_class ON t_contact_class (class_id, contact_date);

-- 園から（t_contact_facility）。取り消していない行は園児×日に1つ
CREATE TABLE t_contact_facility (
  contact_facility_id INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id            TEXT    NOT NULL REFERENCES m_child(child_id),
  class_id            INTEGER NOT NULL REFERENCES m_class(class_id),
  contact_date        TEXT    NOT NULL,
  body                TEXT    NOT NULL,
  staff_id            TEXT    NOT NULL REFERENCES m_staff(staff_id),
  recorded_at         TEXT    NOT NULL,
  corrected_at        TEXT,
  is_deleted          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_contact_facility_alive ON t_contact_facility (child_id, contact_date) WHERE is_deleted = 0;

-- 保護者が開いた時刻（t_contact_read）。1件ずつの既読は持たない
CREATE TABLE t_contact_read (
  child_id     TEXT    NOT NULL REFERENCES m_child(child_id),
  contact_date TEXT    NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES m_account(account_id),
  read_at      TEXT    NOT NULL,
  PRIMARY KEY (child_id, contact_date, account_id)
);

-- ============ 5-7 午睡チェック（足した表） ============

-- ねた・おきた（t_nap_sleep）。伝える層。sleep_temperature だけは監査の層で保護者へ返さない
CREATE TABLE t_nap_sleep (
  nap_sleep_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nap_session_id    INTEGER NOT NULL REFERENCES t_nap_session(nap_session_id),
  child_id          TEXT    NOT NULL REFERENCES m_child(child_id),
  slept_at          TEXT    NOT NULL,                                       -- 入眠
  woke_at           TEXT,                                                   -- slept_at より後（検査で守る）
  sleep_temperature REAL,
  slept_staff_id    TEXT    NOT NULL REFERENCES m_staff(staff_id),
  woke_staff_id     TEXT    REFERENCES m_staff(staff_id),
  corrected_at      TEXT,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_nap_sleep_open ON t_nap_sleep (nap_session_id, child_id) WHERE woke_at IS NULL AND is_deleted = 0;
CREATE INDEX ix_nap_sleep_child ON t_nap_sleep (child_id, slept_at);

-- きょうは対象外（t_nap_exclusion）。監査の層。出欠の記録ではない
CREATE TABLE t_nap_exclusion (
  nap_exclusion_id INTEGER PRIMARY KEY AUTOINCREMENT,
  nap_session_id   INTEGER NOT NULL REFERENCES t_nap_session(nap_session_id),
  child_id         TEXT    NOT NULL REFERENCES m_child(child_id),
  reason           TEXT    NOT NULL CHECK (reason IN ('1','2')),            -- 1:欠席 2:午睡なし
  staff_id         TEXT    NOT NULL REFERENCES m_staff(staff_id),
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_nap_exclusion_alive ON t_nap_exclusion (nap_session_id, child_id) WHERE is_deleted = 0;

-- ============ 5-9 共通（足した表） ============

-- 定型文（m_phrase）。連絡帳と日誌で共通。園が設定画面で直す
CREATE TABLE m_phrase (
  phrase_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase_scope     TEXT    NOT NULL CHECK (phrase_scope IN ('1','2','3','4')),  -- 1:園から 2:ひとこと 3:クラスのようす 4:日誌
  body             TEXT    NOT NULL,
  display_order    INTEGER NOT NULL,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  updated_staff_id TEXT    NOT NULL REFERENCES m_staff(staff_id),
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
