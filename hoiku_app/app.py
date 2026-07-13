# -*- coding: utf-8 -*-
"""
すくすくハイブ 保育支援システム ローカル版
Flask + SQLite （1ファイルバックエンド）

起動:  python app.py  →  http://localhost:5000
DB:    初回起動時に hoiku.db を自動作成してデモデータを投入します。
リセット: hoiku.db を削除して再起動すればOK。
"""
import os
import sqlite3
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, request, session, jsonify, g, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "hoiku.db")

INVITE_CODE = "HIVE-2026"  # 保護者の新規登録用招待コード（デモ値）

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = "hoiku-dev-secret-change-me"  # 本番運用時は環境変数などで管理する
app.permanent_session_lifetime = timedelta(days=14)  # 「ログイン状態を保持」の期間


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
  late       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE naps(
  child_id   INTEGER PRIMARY KEY REFERENCES children(id),
  sleeping   INTEGER NOT NULL DEFAULT 0,
  since      TEXT DEFAULT '',    -- 就寝開始 HH:MM
  last_check TEXT DEFAULT '',    -- 最終チェック HH:MM
  memo       TEXT DEFAULT ''
);

-- 要件: 誰が・いつ・どの園児の記録を変更したかの操作ログ（監査用）
CREATE TABLE nap_logs(
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
        con.execute(
            "INSERT INTO children(name,age_label,emoji,next_check,late) VALUES(?,?,?,?,?)", k
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


def init_db():
    if os.path.exists(DB_PATH):
        return
    con = sqlite3.connect(DB_PATH)
    try:
        con.executescript(SCHEMA)
        seed(con)
        con.commit()
        print("[init] hoiku.db を作成し、デモデータを投入しました。")
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
    if code != INVITE_CODE:
        return jsonify(error="招待コードが正しくありません"), 400
    if not uid or len(pw) < 4:
        return jsonify(error="IDと4文字以上のパスワードを入力してください"), 400
    if db().execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        return jsonify(error="このIDは既に使われています"), 400
    db().execute(
        "INSERT INTO users VALUES(?,?,?,?,?,?,?)",
        (uid, generate_password_hash(pw), "parent", f"{uid}（保護者）", "保", "#7CA65B", "#FFFFFF"),
    )
    db().commit()
    session.permanent = True
    session["uid"] = uid
    row = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    return jsonify(user=user_json(row))


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

    children = [
        dict(r) for r in d.execute(
            """SELECT c.id, c.name, c.age_label, c.emoji, c.next_check, c.late,
                      n.sleeping, n.since, n.last_check, n.memo
               FROM children c JOIN naps n ON n.child_id = c.id
               ORDER BY c.id"""
        )
    ]

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
    )


# ---------------------------------------------------------------- 午睡チェック
def _nap_json(cid):
    r = db().execute("SELECT * FROM naps WHERE child_id=?", (cid,)).fetchone()
    return dict(r)


def _nap_log(cid, action):
    db().execute(
        "INSERT INTO nap_logs(child_id,user_id,action,at) VALUES(?,?,?,?)",
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
    _nap_log(cid, "就寝" if sleeping else "起床")
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
    _nap_log(cid, "メモ更新" if memo else "メモ削除")
    db().commit()
    return jsonify(nap=_nap_json(cid))


@app.get("/api/nap_logs")
@login_required
def api_nap_logs():
    """監査用: 操作ログの確認（管理者のみ）"""
    if my_role() != "admin":
        return jsonify(error="権限がありません"), 403
    rows = db().execute(
        """SELECT l.at, u.display_name AS who, c.name AS child, l.action
           FROM nap_logs l JOIN users u ON u.id=l.user_id
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


# ---------------------------------------------------------------- 起動
init_db()

if __name__ == "__main__":
    print("=" * 52)
    print("  すくすくハイブ ローカル版")
    print("  PCから      : http://localhost:5000")
    print("  同じWi-Fiの端末から : http://<このPCのIPアドレス>:5000")
    print("    (IPアドレスは ipconfig で確認できます)")
    print("=" * 52)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
