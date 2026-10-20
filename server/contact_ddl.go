package main

// contactDDL は詳細設計書「足す表」(5-2) の表と索引。schema.sql の「5-4 連絡帳」以降の節と同じ定義に IF NOT EXISTS を付け、
// 既存の DB へ ensureContactSchema（db_contact.go）が流す。片方を直したらもう片方も直す
const contactDDL = `-- ============ 5-4 連絡帳（基本設計書「連絡帳」(5-4)） ============

-- 写真（t_contact_photo）。実体はファイルシステム（-files の下）。取り消したものは配信しない
CREATE TABLE IF NOT EXISTS t_contact_photo (
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
CREATE TABLE IF NOT EXISTS t_contact_photo_child (
  contact_photo_id INTEGER NOT NULL REFERENCES t_contact_photo(contact_photo_id),
  child_id         TEXT    NOT NULL REFERENCES m_child(child_id),
  consent_level    TEXT    NOT NULL CHECK (consent_level IN ('1','2','3')),
  PRIMARY KEY (contact_photo_id, child_id)
);

-- 家庭から（t_contact_home）。園児×日に1行。状態は列から読む（詳細設計書「家庭から」(3-1)）
CREATE TABLE IF NOT EXISTS t_contact_home (
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
CREATE TABLE IF NOT EXISTS t_contact_event (
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
CREATE INDEX IF NOT EXISTS ix_contact_event_child ON t_contact_event (child_id, contact_date);
CREATE INDEX IF NOT EXISTS ix_contact_event_class ON t_contact_event (class_id, contact_date);
CREATE INDEX IF NOT EXISTS ix_contact_event_photo ON t_contact_event (contact_photo_id);

-- クラスのようす（t_contact_class）。クラスに1行。一意にしない（1日1回は目安）
CREATE TABLE IF NOT EXISTS t_contact_class (
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
CREATE INDEX IF NOT EXISTS ix_contact_class ON t_contact_class (class_id, contact_date);

-- 園から（t_contact_facility）。取り消していない行は園児×日に1つ
CREATE TABLE IF NOT EXISTS t_contact_facility (
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_contact_facility_alive ON t_contact_facility (child_id, contact_date) WHERE is_deleted = 0;

-- 保護者が開いた時刻（t_contact_read）。1件ずつの既読は持たない
CREATE TABLE IF NOT EXISTS t_contact_read (
  child_id     TEXT    NOT NULL REFERENCES m_child(child_id),
  contact_date TEXT    NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES m_account(account_id),
  read_at      TEXT    NOT NULL,
  PRIMARY KEY (child_id, contact_date, account_id)
);

-- ============ 5-7 午睡チェック（足した表） ============

-- ねた・おきた（t_nap_sleep）。伝える層。sleep_temperature だけは監査の層で保護者へ返さない
CREATE TABLE IF NOT EXISTS t_nap_sleep (
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_nap_sleep_open ON t_nap_sleep (nap_session_id, child_id) WHERE woke_at IS NULL AND is_deleted = 0;
CREATE INDEX IF NOT EXISTS ix_nap_sleep_child ON t_nap_sleep (child_id, slept_at);

-- きょうは対象外（t_nap_exclusion）。監査の層。出欠の記録ではない
CREATE TABLE IF NOT EXISTS t_nap_exclusion (
  nap_exclusion_id INTEGER PRIMARY KEY AUTOINCREMENT,
  nap_session_id   INTEGER NOT NULL REFERENCES t_nap_session(nap_session_id),
  child_id         TEXT    NOT NULL REFERENCES m_child(child_id),
  reason           TEXT    NOT NULL CHECK (reason IN ('1','2')),            -- 1:欠席 2:午睡なし
  staff_id         TEXT    NOT NULL REFERENCES m_staff(staff_id),
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_nap_exclusion_alive ON t_nap_exclusion (nap_session_id, child_id) WHERE is_deleted = 0;

-- ============ 5-9 共通（足した表） ============

-- 定型文（m_phrase）。連絡帳と日誌で共通。園が設定画面で直す
CREATE TABLE IF NOT EXISTS m_phrase (
  phrase_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase_scope     TEXT    NOT NULL CHECK (phrase_scope IN ('1','2','3','4')),  -- 1:園から 2:ひとこと 3:クラスのようす 4:日誌
  body             TEXT    NOT NULL,
  display_order    INTEGER NOT NULL,
  is_deleted       INTEGER NOT NULL DEFAULT 0,
  updated_staff_id TEXT    NOT NULL REFERENCES m_staff(staff_id),
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);`
