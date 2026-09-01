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
  terms_version TEXT    NOT NULL UNIQUE,
  document_type TEXT    NOT NULL CHECK (document_type IN ('1','2')),  -- 1:利用規約 2:プライバシーポリシー
  body          TEXT    NOT NULL,
  published_on  TEXT    NOT NULL
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
  is_deleted          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

-- クラス（m_class）。年度ごとに別レコードとし、過年度の割り当てを残す
CREATE TABLE m_class (
  class_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  fiscal_year INTEGER NOT NULL,
  class_name  TEXT    NOT NULL,
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
  link_status  TEXT NOT NULL CHECK (link_status IN ('1','2')),  -- 1:有効 2:終了
  linked_at    TEXT NOT NULL,
  ended_at     TEXT,
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

-- 日誌（t_diary）。記録種別でテーブルを分けない
CREATE TABLE t_diary (
  diary_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type           TEXT    NOT NULL CHECK (record_type IN ('1','2','3','4')),  -- 1:個人 2:クラス 3:週案月案 4:ヒヤリハット
  child_id              TEXT    REFERENCES m_child(child_id),
  class_id              INTEGER REFERENCES m_class(class_id),
  diary_date            TEXT    NOT NULL,
  body                  TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('1','2','3','4')),       -- 1:下書き 2:申請中 3:承認済み 4:差し戻し
  created_staff_id      TEXT    NOT NULL REFERENCES m_staff(staff_id),
  approved_staff_id     TEXT    REFERENCES m_staff(staff_id),
  approved_at           TEXT,
  -- 承認とは別の指定
  is_shared_to_guardian INTEGER NOT NULL DEFAULT 0,
  shared_at             TEXT,
  -- 起票元。ヒヤリハットのみ。異常時の記録と相互に参照する
  nap_abnormal_id       INTEGER REFERENCES t_nap_abnormal(nap_abnormal_id),
  -- 差し戻す理由。差し戻しは理由の入力を必須とする（画面詳細図 3-3）
  returned_reason       TEXT,
  is_deleted            INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);
CREATE INDEX ix_diary_date  ON t_diary (diary_date);
CREATE INDEX ix_diary_child ON t_diary (child_id, diary_date);

-- 編集ロック（t_diary_lock）。取得のたびにトークンを発行し、保存時に照合する
CREATE TABLE t_diary_lock (
  diary_id        INTEGER PRIMARY KEY REFERENCES t_diary(diary_id),
  lock_token      TEXT    NOT NULL UNIQUE,
  locked_staff_id TEXT    NOT NULL REFERENCES m_staff(staff_id),
  locked_at       TEXT    NOT NULL,
  last_active_at  TEXT    NOT NULL
);

-- 雛形（m_diary_template）。保護者共有の既定値を雛形側に持ち、コードに書かない
CREATE TABLE m_diary_template (
  diary_template_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_type               TEXT    NOT NULL CHECK (record_type IN ('1','2','3','4')),
  template_name             TEXT    NOT NULL,
  body                      TEXT    NOT NULL,
  default_share_to_guardian INTEGER NOT NULL DEFAULT 0
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
  thread_status TEXT
);

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
  source_type        TEXT    NOT NULL CHECK (source_type IN ('1','2','3')),  -- 1:手入力 2:日誌の共有 3:発達身体測定の共有
  source_id          INTEGER,
  sent_at            TEXT    NOT NULL,
  edited_at          TEXT,
  is_deleted         INTEGER NOT NULL DEFAULT 0,
  deleted_at         TEXT,
  deleted_account_id INTEGER REFERENCES m_account(account_id)
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
  -- 【設計の穴】所見（チェック単位の自由記述）を保持する列が基本設計書 5-7 の定義にない。
  -- 画面詳細図 6-1 は所見の入力欄を持つため、置き場を決める必要がある。
  -- ここでは note 列を足す案を示している（要判断）。
  note                    TEXT,
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
  account_id       INTEGER NOT NULL REFERENCES m_account(account_id),
  operated_at      TEXT    NOT NULL,
  function_type    TEXT    NOT NULL CHECK (function_type IN ('1','2','3','4','5','6','7')),
  operation_type   TEXT    NOT NULL CHECK (operation_type IN ('1','2','3','4','5')),
  target_table     TEXT    NOT NULL,
  target_id        INTEGER,
  target_child_id  TEXT,
  before_value     TEXT,
  after_value      TEXT
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
