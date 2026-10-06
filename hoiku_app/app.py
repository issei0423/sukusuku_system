# -*- coding: utf-8 -*-
"""
すくすくハイブ 保育支援システム ローカル版
Flask + SQLite （1ファイルバックエンド）

起動:  python app.py  →  http://localhost:5000
DB:    初回起動時に hoiku.db を自動作成してデモデータを投入します。
リセット: hoiku.db を削除して再起動すればOK。
"""
import calendar
import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, request, session, jsonify, g, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("HOIKU_DB") or os.path.join(BASE, "hoiku.db")  # テスト時に差し替え可能

# デモ用の招待コード。園児ごとに1枚ずつ用意し、1枚は1アカウントの登録にのみ使える。
# 以前は全保護者で共用の固定値（HIVE-2026）だった（GitHub Issue #55）
DEMO_INVITATION_CODES = [
    ("SAKU-2026-AAAA", "さくら"),
    ("SAKU-2026-BBBB", "さくら"),
    ("HARU-2026-AAAA", "はると"),
    ("YUI0-2026-AAAA", "ゆい"),
]
INVITATION_VALID_DAYS = 30  # 招待コードの有効期限（日）

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = "hoiku-dev-secret-change-me"  # 本番運用時は環境変数などで管理する
app.permanent_session_lifetime = timedelta(days=14)  # 「ログイン状態を保持」の期間
# クロスサイトからのPOSTにCookieが乗らないようにする（CSRF緩和。本実装ではトークン方式を併用する）
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"


# ---------------------------------------------------------------- DB接続
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    d = g.pop("db", None)
    if d:
        d.close()


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def now_hm():
    return datetime.now().strftime("%H:%M")


# ---------------------------------------------------------------- スキーマ
SCHEMA = """
CREATE TABLE users(
  id            TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('admin','staff','parent')),
  display_name  TEXT NOT NULL,
  avatar        TEXT NOT NULL,   -- アバターの1文字
  bg            TEXT NOT NULL,   -- アバター背景色
  fg            TEXT NOT NULL    -- アバター文字色
);

CREATE TABLE children(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  age_label  TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  next_check TEXT NOT NULL,      -- 発達チェック次回予定（表示用）
  late       INTEGER NOT NULL DEFAULT 0,
  birth_date TEXT NOT NULL DEFAULT '',  -- 生年月日=月齢算出のSSoT
  sex        TEXT NOT NULL DEFAULT 'M'  -- 'M'/'F'（成長曲線の基準値参照用）
);

CREATE TABLE naps(
  child_id   INTEGER PRIMARY KEY REFERENCES children(id),
  sleeping   INTEGER NOT NULL DEFAULT 0,
  since      TEXT DEFAULT '',    -- 就寝開始 HH:MM
  last_check TEXT DEFAULT '',    -- 最終チェック HH:MM
  memo       TEXT DEFAULT ''
);

-- 要件: 誰が・いつ・どの園児の記録を変更したかの操作ログ（監査用）
-- 午睡・身体測定など機能横断で使うため operation_logs とする（旧名 nap_logs）
CREATE TABLE operation_logs(
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id INTEGER NOT NULL,
  user_id  TEXT NOT NULL,
  action   TEXT NOT NULL,
  at       TEXT NOT NULL
);

CREATE TABLE channels(
  id          TEXT PRIMARY KEY,
  icon        TEXT, name TEXT, sub TEXT, grp TEXT,
  perm_admin  TEXT NOT NULL,  -- 'post' / 'read' / 'none'
  perm_staff  TEXT NOT NULL,
  perm_parent TEXT NOT NULL
);

CREATE TABLE messages(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE TABLE nisshi(
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  date   TEXT, dow TEXT, title TEXT, detail TEXT,
  status TEXT NOT NULL CHECK(status IN ('下書き','申請中','承認済み','差し戻し')),
  author TEXT
);

-- 招待コード。1枚＝1アカウント。園児と有効期限が紐づき、使用と同時に使用済みにする
-- （要件定義書「招待コードの発行」(4-1-2)）
CREATE TABLE invitation_codes(
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  child_id     INTEGER NOT NULL REFERENCES children(id),
  expires_on   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('未使用','使用済み','失効')),
  used_user_id TEXT REFERENCES users(id),
  used_at      TEXT,
  issued_by    TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- 園児と保護者の紐づけ。「自児」の判定の根拠になる
CREATE TABLE guardian_children(
  user_id   TEXT NOT NULL REFERENCES users(id),
  child_id  INTEGER NOT NULL REFERENCES children(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY(user_id, child_id)
);

CREATE TABLE dev_items(
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  label    TEXT NOT NULL,
  category TEXT NOT NULL
);

CREATE TABLE dev_results(
  child_id INTEGER NOT NULL,
  item_id  INTEGER NOT NULL,
  result   TEXT NOT NULL,     -- '確認できた' / '一部' / '未確認'
  at       TEXT NOT NULL,
  PRIMARY KEY(child_id, item_id)
);

CREATE TABLE dev_notes(
  child_id INTEGER PRIMARY KEY,
  note     TEXT DEFAULT ''
);
"""

# 身体記録まわりのテーブル。既存DBへの後付け（migrate_db）でも使うため IF NOT EXISTS で分離
PHYSICAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS physical_records(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id    INTEGER NOT NULL REFERENCES children(id),
  measured_on TEXT NOT NULL,     -- YYYY-MM-DD（未来日不可）
  height_cm   REAL NOT NULL,
  weight_kg   REAL NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(child_id, measured_on)  -- 同一園児・同一測定日は上書き
);

CREATE TABLE IF NOT EXISTS growth_standards(
  sex           TEXT NOT NULL,     -- 'M'/'F'
  age_in_months INTEGER NOT NULL,
  measure_type  TEXT NOT NULL,     -- 'height'/'weight'
  percentile    INTEGER NOT NULL,  -- 3/50/97（モックでは3本に簡略化）
  value         REAL NOT NULL,
  PRIMARY KEY(sex, age_in_months, measure_type, percentile)
);

-- 設計原則「ハードコードを避けマスタで運用」に合わせ、しきい値は settings で保持
CREATE TABLE IF NOT EXISTS settings(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

# 入力範囲チェックの初期値（誤入力検知が目的。発育の判定基準ではない）
PHYSICAL_SETTINGS = {
    "height_min": "30.0", "height_max": "150.0",
    "weight_min": "1.0",  "weight_max": "40.0",
}

# デモ園児の生年月日・性別（age_label と整合する値）
KID_BIRTHS = {
    "さくら": ("2025-03-10", "F"),
    "はると": ("2025-08-15", "M"),
    "ゆい":   ("2024-11-05", "F"),
    "そうた": ("2025-05-12", "M"),
    "めい":   ("2025-01-20", "F"),
    "りく":   ("2025-07-08", "M"),
}

# 成長曲線のアンカー値 {月齢: (3パーセンタイル, 50, 97)}
# 厚労省 乳幼児身体発育調査(2010年)の曲線を参考にしたデモ用の近似値であり、
# 公表値そのものではない。本実装時は公表値からマスタ投入すること（要決定事項）。
GROWTH_ANCHORS = {
    ("M", "height"): {0: (44.0, 49.0, 52.6), 6: (63.6, 67.9, 72.1), 12: (70.3, 75.0, 79.6),
                      18: (74.8, 80.3, 85.9), 24: (78.7, 85.1, 91.5), 36: (85.9, 93.3, 100.6)},
    ("F", "height"): {0: (43.5, 48.5, 52.0), 6: (61.9, 66.4, 70.4), 12: (68.3, 73.4, 78.2),
                      18: (73.0, 79.2, 84.6), 24: (77.0, 84.0, 90.3), 36: (84.7, 92.2, 99.8)},
    ("M", "weight"): {0: (2.5, 3.0, 3.8), 6: (6.4, 8.0, 9.9), 12: (7.7, 9.3, 11.5),
                      18: (8.7, 10.4, 12.8), 24: (9.6, 11.5, 14.2), 36: (11.0, 13.5, 17.0)},
    ("F", "weight"): {0: (2.4, 2.9, 3.7), 6: (6.1, 7.5, 9.4), 12: (7.2, 8.7, 10.9),
                      18: (8.1, 9.8, 12.2), 24: (9.0, 10.9, 13.6), 36: (10.5, 13.0, 16.5)},
}


def months_between(birth, on):
    """生年月日(YYYY-MM-DD)から on 時点の月齢を算出する（応当日基準）

    基準日の時点で、生年月日の応当日を何回迎えたかを月齢とする。
    応当日が存在しない月（1月31日生まれの2月など）は、その月の末日を応当日とみなす
    （要件定義書「記録の一貫性」(7-1 No.6)）。
    月齢を使う処理は、機能ごとに計算せず必ずこの関数を呼ぶ。
    """
    b = datetime.strptime(birth, "%Y-%m-%d")
    o = datetime.strptime(on, "%Y-%m-%d")
    m = (o.year - b.year) * 12 + (o.month - b.month)
    anniversary_day = min(b.day, calendar.monthrange(o.year, o.month)[1])
    if o.day < anniversary_day:
        m -= 1
    return max(m, 0)


def age_label_from(birth_date):
    """生年月日（SSoT）から現在の年齢表示を導出する。未登録なら None"""
    if not birth_date:
        return None
    m = months_between(birth_date, datetime.now().strftime("%Y-%m-%d"))
    return f"{m // 12}歳{m % 12}ヶ月"


def _interp_anchors(anchors, m):
    """アンカー月齢の間を線形補間して (p3, p50, p97) を返す"""
    keys = sorted(anchors)
    if m <= keys[0]:
        return anchors[keys[0]]
    for a, b in zip(keys, keys[1:]):
        if m <= b:
            t = (m - a) / (b - a)
            return tuple(round(x + (y - x) * t, 2) for x, y in zip(anchors[a], anchors[b]))
    return anchors[keys[-1]]


def seed_physical(con):
    """身体記録まわりのマスタ・デモデータ投入（何度呼んでも安全）"""
    con.row_factory = sqlite3.Row

    for k, v in PHYSICAL_SETTINGS.items():
        con.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))

    if not con.execute("SELECT 1 FROM growth_standards LIMIT 1").fetchone():
        rows = []
        for (sex, mtype), anchors in GROWTH_ANCHORS.items():
            for m in range(0, 37):
                p3, p50, p97 = _interp_anchors(anchors, m)
                rows += [(sex, m, mtype, 3, p3), (sex, m, mtype, 50, p50), (sex, m, mtype, 97, p97)]
        con.executemany("INSERT INTO growth_standards VALUES(?,?,?,?,?)", rows)

    if not con.execute("SELECT 1 FROM physical_records LIMIT 1").fetchone():
        today = datetime.now()
        kids = con.execute("SELECT id, birth_date, sex FROM children WHERE birth_date!=''").fetchall()
        for k in kids:
            bias = ((k["id"] * 7) % 5 - 2) * 0.02  # 園児ごとの個体差(-4%〜+4%)を決め打ちで再現
            for back in range(5, -1, -1):
                y, mth = today.year, today.month - back
                while mth < 1:
                    mth += 12
                    y -= 1
                measured = f"{y:04d}-{mth:02d}-05"
                if measured > today.strftime("%Y-%m-%d"):
                    continue
                am = months_between(k["birth_date"], measured)
                h = _interp_anchors(GROWTH_ANCHORS[(k["sex"], "height")], am)[1] * (1 + bias)
                w = _interp_anchors(GROWTH_ANCHORS[(k["sex"], "weight")], am)[1] * (1 + bias * 1.5)
                con.execute(
                    """INSERT OR IGNORE INTO physical_records
                       (child_id,measured_on,height_cm,weight_kg,recorded_by,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""",
                    (k["id"], measured, round(h, 1), round(w, 1), "tanaka", now_iso(), now_iso()),
                )


def seed(con):
    """初回起動時のデモデータ投入"""
    today = datetime.now().strftime("%Y-%m-%d")

    users = [
        ("encho",  "encho",  "admin",  "園長先生", "園", "#F2B33D", "#4A3B2A"),
        ("shunin", "shunin", "admin",  "主任",     "主", "#5E93C5", "#FFFFFF"),
        ("tanaka", "tanaka", "staff",  "田中先生", "田", "#F2B33D", "#4A3B2A"),
        ("sato",   "sato",   "parent", "さとう（さくら保護者）", "保", "#7CA65B", "#FFFFFF"),
    ]
    for uid, pw, role, name, av, bg, fg in users:
        con.execute(
            "INSERT INTO users VALUES(?,?,?,?,?,?,?)",
            (uid, generate_password_hash(pw), role, name, av, bg, fg),
        )

    kids = [
        ("さくら", "1歳4ヶ月",  "🐣", "7/10", 0),
        ("はると", "0歳11ヶ月", "🐥", "予定日超過", 1),
        ("ゆい",   "1歳8ヶ月",  "🐤", "7/22 ※個別", 0),
        ("そうた", "1歳2ヶ月",  "🐧", "7/15", 0),
        ("めい",   "1歳6ヶ月",  "🐰", "7/18", 0),
        ("りく",   "1歳0ヶ月",  "🐻", "7/12", 0),
    ]
    for k in kids:
        bd, sex = KID_BIRTHS.get(k[0], ("", "M"))
        con.execute(
            "INSERT INTO children(name,age_label,emoji,next_check,late,birth_date,sex) VALUES(?,?,?,?,?,?,?)",
            k + (bd, sex),
        )

    naps = [
        (1, 1, "12:45", "13:02", ""),
        (2, 1, "12:50", "13:05", "鼻血が少し出た。5分ほどで止血、様子見中。"),
        (3, 0, "",      "13:02", ""),
        (4, 1, "12:48", "13:04", ""),
        (5, 1, "12:52", "13:03", ""),
        (6, 0, "",      "13:05", "咳が数回。水分補給済み。"),
    ]
    con.executemany("INSERT INTO naps VALUES(?,?,?,?,?)", naps)

    channels = [
        ("en",        "📣", "園チャット",           "園全体のお知らせ", "園全体",  "post", "read", "read"),
        ("himawari",  "🌻", "ひまわり組",           "メンバー 24名",   "グループ", "post", "post", "read"),
        ("staffroom", "👥", "職員チャット",         "職員のみ",        "グループ", "post", "post", "none"),
        ("dm_sakura", "🏠", "さくらさん 個人チャット", "園 ⇄ 保護者",    "個人",    "none", "post", "post"),
    ]
    con.executemany("INSERT INTO channels VALUES(?,?,?,?,?,?,?,?)", channels)

    msgs = [
        ("en",        "encho",  "【お知らせ】7/12(土) 夏まつりを開催します🍉 詳細は今週のおたよりでご案内します。", f"{today} 08:30:00"),
        ("en",        "shunin", "駐車場に限りがあるため、当日は徒歩・自転車でのご来園にご協力ください。",        f"{today} 08:45:00"),
        ("himawari",  "tanaka", "今日は七夕かざりを作ります🎋 短冊のお写真、あとでこちらに載せますね！",          f"{today} 09:12:00"),
        ("himawari",  "shunin", "📎 7月のおたより.pdf を添付しました。園チャットにも掲載しています。",           f"{today} 09:30:00"),
        ("staffroom", "shunin", "本日の遅番は田中先生です。午睡チェックの引き継ぎをお願いします。",              f"{today} 08:05:00"),
        ("staffroom", "tanaka", "承知しました！",                                                              f"{today} 08:07:00"),
        ("dm_sakura", "sato",   "おはようございます。昨夜すこし咳が出ていたので、日中の様子を見ていただけると助かります。", f"{today} 08:20:00"),
        ("dm_sakura", "tanaka", "承知しました。午睡の様子と合わせて、こちらでご報告しますね。",                  f"{today} 08:25:00"),
    ]
    con.executemany("INSERT INTO messages(channel_id,user_id,body,at) VALUES(?,?,?,?)", msgs)

    nisshi = [
        ("7/7", "火", "クラス日誌 ─ 七夕かざりをつくったよ 🎋", "担任: 田中 ／ 写真 2枚 ／ タグ: 晴れ・給食完食・お昼寝(○)", "申請中",  "tanaka"),
        ("7/6", "月", "個人日誌 ─ さくら さん",                 "担任: 田中 ／ 過去記録タイムラインあり ／ 保護者へ共有済み", "承認済み", "tanaka"),
        ("7/6", "月", "クラス日誌 ─ 水あそび",                  "主任コメント: ヒヤリハット欄の追記をお願いします",           "差し戻し", "tanaka"),
        ("7/8", "水", "週案（7/8〜7/12）",                      "自動保存: 2分前",                                           "下書き",   "tanaka"),
    ]
    con.executemany("INSERT INTO nisshi(date,dow,title,detail,status,author) VALUES(?,?,?,?,?,?)", nisshi)

    items = [
        ("ひとりで数歩あるく",                     "運動"),
        ("意味のある単語を話す（ママ・ワンワン等）", "言葉"),
        ("スプーンを使おうとする",                 "生活"),
        ("大人の言葉かけに応じようとする",         "人間関係"),
    ]
    con.executemany("INSERT INTO dev_items(label,category) VALUES(?,?)", items)

    results = [(1, 1, "確認できた"), (1, 2, "確認できた"), (1, 3, "一部")]
    for cid, iid, res in results:
        con.execute(
            "INSERT INTO dev_results VALUES(?,?,?,?)", (cid, iid, res, f"{today} 10:00:00")
        )
    con.execute("INSERT INTO dev_notes VALUES(1, '階段の昇りに興味を示すようになった。')")


INVITATION_SCHEMA = """
CREATE TABLE IF NOT EXISTS invitation_codes(
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  child_id     INTEGER NOT NULL REFERENCES children(id),
  expires_on   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('未使用','使用済み','失効')),
  used_user_id TEXT REFERENCES users(id),
  used_at      TEXT,
  issued_by    TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guardian_children(
  user_id   TEXT NOT NULL REFERENCES users(id),
  child_id  INTEGER NOT NULL REFERENCES children(id),
  linked_at TEXT NOT NULL,
  PRIMARY KEY(user_id, child_id)
);
"""


def seed_invitations(con):
    """デモ用の招待コードと、既存のデモ保護者の紐づけを投入する。入っていれば何もしない"""
    if con.execute("SELECT 1 FROM invitation_codes LIMIT 1").fetchone():
        return
    now = datetime.now()
    expires = (now + timedelta(days=INVITATION_VALID_DAYS)).strftime("%Y-%m-%d")
    for code, child_name in DEMO_INVITATION_CODES:
        row = con.execute("SELECT id FROM children WHERE name=?", (child_name,)).fetchone()
        if row:
            con.execute(
                "INSERT INTO invitation_codes(code,child_id,expires_on,status,issued_by,created_at)"
                " VALUES(?,?,?,'未使用','encho',?)",
                (code, row[0], expires, now.strftime("%Y-%m-%d %H:%M:%S")),
            )
    # デモの保護者（さとう）は、さくらの保護者として登録済みの扱いにする
    sakura = con.execute("SELECT id FROM children WHERE name='さくら'").fetchone()
    if sakura and con.execute("SELECT 1 FROM users WHERE id='sato'").fetchone():
        con.execute(
            "INSERT OR IGNORE INTO guardian_children VALUES('sato',?,?)",
            (sakura[0], now.strftime("%Y-%m-%d %H:%M:%S")),
        )


def normalize_invitation_code(code):
    """入力された招待コードを照合用の形に直す。大文字・小文字を区別せず、ハイフンと空白は無視する"""
    return "".join(ch for ch in (code or "").upper() if ch not in "-ー－‐" and not ch.isspace())


def new_invitation_code():
    """推測しにくい値を作る（要件定義書「セキュリティ要求」(8)）。紛らわしい文字（0/O、1/I）は使わない"""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    block = lambda: "".join(secrets.choice(alphabet) for _ in range(4))  # noqa: E731
    return f"{block()}-{block()}-{block()}"


def init_db():
    if os.path.exists(DB_PATH):
        return
    con = sqlite3.connect(DB_PATH)
    try:
        con.executescript(SCHEMA)
        con.executescript(PHYSICAL_SCHEMA)
        seed(con)
        seed_physical(con)
        seed_invitations(con)
        con.commit()
        print("[init] hoiku.db を作成し、デモデータを投入しました。")
    finally:
        con.close()


def migrate_db():
    """旧バージョンで作成された hoiku.db への後付けマイグレーション"""
    if not os.path.exists(DB_PATH):
        return
    con = sqlite3.connect(DB_PATH)
    try:
        cols = [r[1] for r in con.execute("PRAGMA table_info(children)")]
        if "birth_date" not in cols:
            con.execute("ALTER TABLE children ADD COLUMN birth_date TEXT NOT NULL DEFAULT ''")
            con.execute("ALTER TABLE children ADD COLUMN sex TEXT NOT NULL DEFAULT 'M'")
            # デモデータ限定の名前マッチ。設定済み（birth_date あり）の行は上書きしない
            for name, (bd, sex) in KID_BIRTHS.items():
                con.execute(
                    "UPDATE children SET birth_date=?, sex=? WHERE name=? AND birth_date=''",
                    (bd, sex, name),
                )
        # 操作ログテーブルの改名（旧 nap_logs → operation_logs）
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "nap_logs" in tables and "operation_logs" not in tables:
            con.execute("ALTER TABLE nap_logs RENAME TO operation_logs")
        con.executescript(PHYSICAL_SCHEMA)
        seed_physical(con)
        # 招待コードと紐づけの表を、この表を足す前に作られた hoiku.db にも用意する
        con.executescript(INVITATION_SCHEMA)
        seed_invitations(con)
        con.commit()
    finally:
        con.close()


# ---------------------------------------------------------------- 認可ヘルパー
def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if "uid" not in session:
            return jsonify(error="ログインしてください"), 401
        return f(*args, **kwargs)
    return wrapper


def me_row():
    return db().execute("SELECT * FROM users WHERE id=?", (session["uid"],)).fetchone()


def my_role():
    return me_row()["role"]


def channel_perm(ch_row, role):
    return ch_row["perm_" + role]


def user_json(row):
    return {"id": row["id"], "name": row["display_name"], "role": row["role"]}


# ---------------------------------------------------------------- 画面
@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ---------------------------------------------------------------- 認証API
@app.post("/api/login")
def api_login():
    d = request.get_json(force=True)
    row = db().execute("SELECT * FROM users WHERE id=?", (d.get("id", ""),)).fetchone()
    if not row or not check_password_hash(row["password_hash"], d.get("password", "")):
        return jsonify(error="IDまたはパスワードが違います"), 401
    session.permanent = bool(d.get("remember"))  # ログイン状態を一定期間保存
    session["uid"] = row["id"]
    return jsonify(user=user_json(row))


@app.post("/api/signup")
def api_signup():
    """保護者の新規登録（招待コード方式）。職員アカウントは管理者発行の想定。"""
    d = request.get_json(force=True)
    code, uid, pw = d.get("code", ""), d.get("id", "").strip(), d.get("password", "")
    inv, error = _usable_invitation(code)
    if error:
        return jsonify(error=error), 400
    if not uid or len(pw) < 4:
        return jsonify(error="IDと4文字以上のパスワードを入力してください"), 400
    if db().execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        return jsonify(error="このIDは既に使われています"), 400
    db().execute(
        "INSERT INTO users VALUES(?,?,?,?,?,?,?)",
        (uid, generate_password_hash(pw), "parent", f"{uid}（保護者）", "保", "#7CA65B", "#FFFFFF"),
    )
    # 使用と同時に使用済みにする。未使用のものだけを更新し、同時に2人が同じコードで登録できないようにする
    used = db().execute(
        "UPDATE invitation_codes SET status='使用済み', used_user_id=?, used_at=? WHERE id=? AND status='未使用'",
        (uid, now_iso(), inv["id"]),
    )
    if used.rowcount != 1:
        db().rollback()
        return jsonify(error="この招待コードは既に使用されています"), 400
    # コードに紐づく園児と、登録した保護者を紐づける。「自児」の判定の根拠になる
    db().execute(
        "INSERT INTO guardian_children VALUES(?,?,?)", (uid, inv["child_id"], now_iso())
    )
    db().commit()
    session.permanent = True
    session["uid"] = uid
    row = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return jsonify(user=user_json(row))


def _usable_invitation(code):
    """使える招待コードを引く。使えないときは (None, 理由) を返す"""
    normalized = normalize_invitation_code(code)
    row = None
    if normalized:
        for r in db().execute("SELECT * FROM invitation_codes"):
            if normalize_invitation_code(r["code"]) == normalized:
                row = r
                break
    if row is None:
        return None, "招待コードが正しくありません"
    if row["status"] == "使用済み":
        return None, "この招待コードは既に使用されています"
    if row["status"] == "失効":
        return None, "この招待コードは失効しています"
    if row["expires_on"] < datetime.now().strftime("%Y-%m-%d"):
        return None, "この招待コードは有効期限が切れています"
    return row, None


# ---------------------------------------------------------------- 招待コードの管理（管理者のみ）
def _invitation_json(r):
    return {
        "id": r["id"], "code": r["code"], "child_id": r["child_id"], "child_name": r["child_name"],
        "expires_on": r["expires_on"], "status": r["status"],
        "used_user_id": r["used_user_id"], "used_at": r["used_at"],
    }


@app.get("/api/invitations")
@login_required
def api_invitations():
    if my_role() != "admin":
        return jsonify(error="招待コードの管理は管理者のみが行えます"), 403
    rows = db().execute(
        "SELECT i.*, c.name AS child_name FROM invitation_codes i"
        " JOIN children c ON c.id = i.child_id ORDER BY c.id, i.id"
    ).fetchall()
    return jsonify(invitations=[_invitation_json(r) for r in rows])


@app.post("/api/invitations")
@login_required
def api_invitations_issue():
    """園児ごとに必要な枚数を発行する。両親それぞれに配るなら2枚"""
    if my_role() != "admin":
        return jsonify(error="招待コードの発行は管理者のみが行えます"), 403
    d = request.get_json(force=True)
    try:
        child_id = int(d.get("child_id"))
        count = int(d.get("count", 1))
        valid_days = int(d.get("valid_days", INVITATION_VALID_DAYS))
    except (TypeError, ValueError):
        return jsonify(error="園児・枚数・有効期限を正しく指定してください"), 400
    if not db().execute("SELECT 1 FROM children WHERE id=?", (child_id,)).fetchone():
        return jsonify(error="園児が見つかりません"), 400
    if not 1 <= count <= 5:
        return jsonify(error="枚数は1〜5枚で指定してください"), 400
    if not 1 <= valid_days <= 365:
        return jsonify(error="有効期限は1〜365日で指定してください"), 400
    expires = (datetime.now() + timedelta(days=valid_days)).strftime("%Y-%m-%d")
    codes = []
    for _ in range(count):
        code = new_invitation_code()
        db().execute(
            "INSERT INTO invitation_codes(code,child_id,expires_on,status,issued_by,created_at)"
            " VALUES(?,?,?,'未使用',?,?)",
            (code, child_id, expires, session["uid"], now_iso()),
        )
        codes.append(code)
    _op_log(child_id, f"招待コードを {count} 枚発行")
    db().commit()
    return jsonify(codes=codes, expires_on=expires)


@app.post("/api/invitations/<int:inv_id>/revoke")
@login_required
def api_invitations_revoke(inv_id):
    if my_role() != "admin":
        return jsonify(error="招待コードの失効は管理者のみが行えます"), 403
    row = db().execute("SELECT * FROM invitation_codes WHERE id=?", (inv_id,)).fetchone()
    if not row:
        return jsonify(error="招待コードが見つかりません"), 404
    if row["status"] == "使用済み":
        return jsonify(error="使用済みの招待コードは失効できません"), 400
    db().execute("UPDATE invitation_codes SET status='失効' WHERE id=?", (inv_id,))
    _op_log(row["child_id"], "招待コードを失効")
    db().commit()
    return jsonify(ok=True)


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@login_required
def api_me():
    return jsonify(user=user_json(me_row()))


# ---------------------------------------------------------------- 一括取得
@app.get("/api/bootstrap")
@login_required
def api_bootstrap():
    role = my_role()
    d = db()

    children = []
    for r in d.execute(
        """SELECT c.id, c.name, c.age_label, c.emoji, c.next_check, c.late,
                  c.birth_date, c.sex,
                  n.sleeping, n.since, n.last_check, n.memo,
                  MAX(p.measured_on) AS last_measured
           FROM children c JOIN naps n ON n.child_id = c.id
           LEFT JOIN physical_records p ON p.child_id = c.id
           GROUP BY c.id
           ORDER BY c.id"""
    ):
        row = dict(r)
        # 年齢表示は生年月日（SSoT）から導出。未登録の場合のみ静的な age_label を使う
        row["age_label"] = age_label_from(row["birth_date"]) or row["age_label"]
        children.append(row)

    channels = []
    for r in d.execute("SELECT * FROM channels"):
        perm = channel_perm(r, role)
        if perm == "none":
            continue
        channels.append(
            {"id": r["id"], "icon": r["icon"], "name": r["name"],
             "sub": r["sub"], "grp": r["grp"], "perm": perm}
        )

    if role == "parent":
        # 保護者は承認済みの日誌のみ（個人チャット経由共有の簡易表現）
        rows = d.execute("SELECT * FROM nisshi WHERE status='承認済み' ORDER BY id")
    else:
        rows = d.execute("SELECT * FROM nisshi ORDER BY id")
    nisshi = [dict(r) for r in rows]

    dev_items = [dict(r) for r in d.execute("SELECT * FROM dev_items ORDER BY id")]

    return jsonify(
        user=user_json(me_row()),
        children=children,
        channels=channels,
        nisshi=nisshi,
        dev_items=dev_items,
        today=datetime.now().strftime("%Y-%m-%d"),  # 「本日入力済」判定はサーバ日付を正とする
    )


# ---------------------------------------------------------------- 午睡チェック
def _nap_json(cid):
    r = db().execute("SELECT * FROM naps WHERE child_id=?", (cid,)).fetchone()
    return dict(r)


def _op_log(cid, action):
    """操作ログ（監査用）。午睡・身体測定など機能横断で記録する"""
    db().execute(
        "INSERT INTO operation_logs(child_id,user_id,action,at) VALUES(?,?,?,?)",
        (cid, session["uid"], action, now_iso()),
    )


@app.post("/api/nap/<int:cid>/toggle")
@login_required
def api_nap_toggle(cid):
    if my_role() == "parent":
        return jsonify(error="権限がありません"), 403
    r = db().execute("SELECT sleeping FROM naps WHERE child_id=?", (cid,)).fetchone()
    if not r:
        return jsonify(error="園児が見つかりません"), 404
    sleeping = 0 if r["sleeping"] else 1
    db().execute(
        "UPDATE naps SET sleeping=?, since=?, last_check=? WHERE child_id=?",
        (sleeping, now_hm() if sleeping else "", now_hm(), cid),
    )
    _op_log(cid, "就寝" if sleeping else "起床")
    db().commit()
    return jsonify(nap=_nap_json(cid))


@app.post("/api/nap/<int:cid>/memo")
@login_required
def api_nap_memo(cid):
    if my_role() == "parent":
        return jsonify(error="権限がありません"), 403
    memo = (request.get_json(force=True).get("memo") or "").strip()
    db().execute(
        "UPDATE naps SET memo=?, last_check=? WHERE child_id=?", (memo, now_hm(), cid)
    )
    _op_log(cid, "メモ更新" if memo else "メモ削除")
    db().commit()
    return jsonify(nap=_nap_json(cid))


@app.get("/api/logs")
@login_required
def api_logs():
    """監査用: 操作ログの確認（管理者のみ）"""
    if my_role() != "admin":
        return jsonify(error="権限がありません"), 403
    rows = db().execute(
        """SELECT l.at, u.display_name AS who, c.name AS child, l.action
           FROM operation_logs l JOIN users u ON u.id=l.user_id
           JOIN children c ON c.id=l.child_id
           ORDER BY l.id DESC LIMIT 100"""
    )
    return jsonify(logs=[dict(r) for r in rows])


# ---------------------------------------------------------------- チャット
@app.get("/api/channels/<ch_id>/messages")
@login_required
def api_messages(ch_id):
    ch = db().execute("SELECT * FROM channels WHERE id=?", (ch_id,)).fetchone()
    if not ch:
        return jsonify(error="チャンネルが見つかりません"), 404
    perm = channel_perm(ch, my_role())
    if perm == "none":
        return jsonify(error="権限がありません"), 403
    rows = db().execute(
        """SELECT m.id, m.body, m.at, m.user_id,
                  u.display_name AS who, u.avatar, u.bg, u.fg
           FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id=? ORDER BY m.id""",
        (ch_id,),
    )
    msgs = []
    for r in rows:
        msgs.append(
            {"id": r["id"], "body": r["body"], "time": r["at"][11:16],
             "who": r["who"], "avatar": r["avatar"], "bg": r["bg"], "fg": r["fg"],
             "mine": r["user_id"] == session["uid"]}
        )
    return jsonify(messages=msgs, perm=perm)


@app.post("/api/channels/<ch_id>/messages")
@login_required
def api_send(ch_id):
    ch = db().execute("SELECT * FROM channels WHERE id=?", (ch_id,)).fetchone()
    if not ch:
        return jsonify(error="チャンネルが見つかりません"), 404
    if channel_perm(ch, my_role()) != "post":
        return jsonify(error="このチャンネルには投稿できません"), 403
    body = (request.get_json(force=True).get("body") or "").strip()
    if not body:
        return jsonify(error="メッセージが空です"), 400
    db().execute(
        "INSERT INTO messages(channel_id,user_id,body,at) VALUES(?,?,?,?)",
        (ch_id, session["uid"], body, now_iso()),
    )
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- 日誌
@app.post("/api/nisshi/<int:nid>/status")
@login_required
def api_nisshi_status(nid):
    if my_role() != "admin":
        return jsonify(error="承認・差し戻しは管理者のみ行えます"), 403
    status = request.get_json(force=True).get("status")
    if status not in ("承認済み", "差し戻し"):
        return jsonify(error="不正なステータスです"), 400
    db().execute("UPDATE nisshi SET status=? WHERE id=?", (status, nid))
    db().commit()
    row = db().execute("SELECT * FROM nisshi WHERE id=?", (nid,)).fetchone()
    return jsonify(nisshi=dict(row))


# ---------------------------------------------------------------- 発達チェック
@app.get("/api/dev/<int:cid>")
@login_required
def api_dev_get(cid):
    rows = db().execute(
        "SELECT item_id, result FROM dev_results WHERE child_id=?", (cid,)
    )
    note = db().execute("SELECT note FROM dev_notes WHERE child_id=?", (cid,)).fetchone()
    return jsonify(
        results={str(r["item_id"]): r["result"] for r in rows},
        note=note["note"] if note else "",
    )


@app.post("/api/dev/<int:cid>")
@login_required
def api_dev_post(cid):
    if my_role() == "parent":
        return jsonify(error="権限がありません"), 403
    d = request.get_json(force=True)
    if "item_id" in d:
        if d.get("result") not in ("確認できた", "一部", "未確認"):
            return jsonify(error="不正な値です"), 400
        db().execute(
            """INSERT INTO dev_results(child_id,item_id,result,at) VALUES(?,?,?,?)
               ON CONFLICT(child_id,item_id) DO UPDATE SET result=excluded.result, at=excluded.at""",
            (cid, d["item_id"], d["result"], now_iso()),
        )
    if "note" in d:
        db().execute(
            """INSERT INTO dev_notes(child_id,note) VALUES(?,?)
               ON CONFLICT(child_id) DO UPDATE SET note=excluded.note""",
            (cid, (d["note"] or "").strip()),
        )
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- 身体記録
def _setting_float(key, default):
    r = db().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    try:
        return float(r["value"]) if r else default
    except ValueError:
        print(f"[warn] settings.{key} が数値ではありません（値: {r['value']!r}）。デフォルト {default} を使用します。")
        return default


def _physical_records(cid, birth_date):
    rows = db().execute(
        """SELECT p.measured_on, p.height_cm, p.weight_kg,
                  COALESCE(u.display_name, p.recorded_by) AS recorded_by
           FROM physical_records p LEFT JOIN users u ON u.id = p.recorded_by
           WHERE p.child_id=? ORDER BY p.measured_on""",
        (cid,),
    )
    recs = []
    for r in rows:
        rec = dict(r)
        rec["age_m"] = months_between(birth_date, r["measured_on"]) if birth_date else None
        recs.append(rec)
    return recs


@app.get("/api/physical/<int:cid>")
@login_required
def api_physical_get(cid):
    # 保護者の閲覧は保護者ポータル側の責務（本システム側画面なし）
    if my_role() == "parent":
        return jsonify(error="権限がありません"), 403
    c = db().execute("SELECT * FROM children WHERE id=?", (cid,)).fetchone()
    if not c:
        return jsonify(error="園児が見つかりません"), 404
    return jsonify(
        child={"id": c["id"], "name": c["name"],
               "age_label": age_label_from(c["birth_date"]) or c["age_label"],
               "emoji": c["emoji"], "birth_date": c["birth_date"], "sex": c["sex"]},
        records=_physical_records(cid, c["birth_date"]),
        today=datetime.now().strftime("%Y-%m-%d"),
        limits={"height_min": _setting_float("height_min", 30.0),
                "height_max": _setting_float("height_max", 150.0),
                "weight_min": _setting_float("weight_min", 1.0),
                "weight_max": _setting_float("weight_max", 40.0)},
    )


@app.post("/api/physical/<int:cid>")
@login_required
def api_physical_post(cid):
    if my_role() == "parent":
        return jsonify(error="権限がありません"), 403
    c = db().execute("SELECT * FROM children WHERE id=?", (cid,)).fetchone()
    if not c:
        return jsonify(error="園児が見つかりません"), 404
    d = request.get_json(force=True)

    measured_on = (d.get("measured_on") or "").strip()
    if not measured_on:
        return jsonify(error="測定日は必須項目です"), 400
    try:
        datetime.strptime(measured_on, "%Y-%m-%d")
    except ValueError:
        return jsonify(error="測定日の形式が正しくありません"), 400
    if measured_on > datetime.now().strftime("%Y-%m-%d"):
        return jsonify(error="測定日に未来の日付は指定できません"), 400

    if d.get("height_cm") in (None, "") or d.get("weight_kg") in (None, ""):
        return jsonify(error="身長・体重は必須項目です"), 400
    try:
        height = float(d["height_cm"])
        weight = float(d["weight_kg"])
    except (TypeError, ValueError):
        return jsonify(error="身長・体重は数値で入力してください"), 400

    # 範囲チェック（しきい値は settings マスタ。誤入力検知が目的で、発育の判定ではない）
    if not d.get("confirm_range"):
        ok_h = _setting_float("height_min", 30.0) <= height <= _setting_float("height_max", 150.0)
        ok_w = _setting_float("weight_min", 1.0) <= weight <= _setting_float("weight_max", 40.0)
        if not (ok_h and ok_w):
            return jsonify(confirm="range",
                           message="入力値が通常の範囲外です。測定値に誤りがないか確認してください。")

    # 同一園児・同一測定日は上書き確認
    exists = db().execute(
        "SELECT 1 FROM physical_records WHERE child_id=? AND measured_on=?",
        (cid, measured_on),
    ).fetchone()
    if exists and not d.get("confirm_overwrite"):
        return jsonify(confirm="overwrite",
                       message="この測定日の記録は登録済みです。上書きしますか。")

    db().execute(
        """INSERT INTO physical_records
           (child_id,measured_on,height_cm,weight_kg,recorded_by,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(child_id,measured_on) DO UPDATE SET
             height_cm=excluded.height_cm, weight_kg=excluded.weight_kg,
             recorded_by=excluded.recorded_by, updated_at=excluded.updated_at""",
        (cid, measured_on, round(height, 1), round(weight, 1),
         session["uid"], now_iso(), now_iso()),
    )
    _op_log(cid, "身体測定 上書き" if exists else "身体測定 記録")  # 監査ログ（操作ログ）に残す
    db().commit()
    return jsonify(ok=True, records=_physical_records(cid, c["birth_date"]))


@app.get("/api/growth_standards")
@login_required
def api_growth_standards():
    if my_role() == "parent":
        return jsonify(error="権限がありません"), 403
    sex = request.args.get("sex", "M")
    mtype = request.args.get("type", "height")
    if sex not in ("M", "F") or mtype not in ("height", "weight"):
        return jsonify(error="不正なパラメータです"), 400
    rows = db().execute(
        """SELECT age_in_months, percentile, value FROM growth_standards
           WHERE sex=? AND measure_type=? ORDER BY age_in_months""",
        (sex, mtype),
    )
    return jsonify(standards=[dict(r) for r in rows])


# ---------------------------------------------------------------- 起動
init_db()
migrate_db()

if __name__ == "__main__":
    print("=" * 52)
    print("  すくすくハイブ ローカル版")
    print("  PCから      : http://localhost:5000")
    print("  同じWi-Fiの端末から : http://<このPCのIPアドレス>:5000")
    print("    (IPアドレスは ipconfig で確認できます)")
    print("=" * 52)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
