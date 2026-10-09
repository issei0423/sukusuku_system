# -*- coding: utf-8 -*-
"""月齢の算出と招待コードのテスト

月齢：テスト仕様書 TC-PHYS-023〜029（応当日基準。要件定義書「記録の一貫性」(7-1 No.6)）
招待コード：1枚＝1アカウント（要件定義書「招待コードの発行」(4-1-2)）

実行: hoiku_app ディレクトリで `pytest`
"""
import os
import sqlite3
import sys
import tempfile

import pytest

# アプリ本体を import する前にテスト用DBパスを指定する。ほかのテストが先に読み込んでいれば、
# アプリはそちらのDBを使っている。DBを直接開くときは hoiku.DB_PATH を使う
os.environ.setdefault("HOIKU_DB", os.path.join(tempfile.mkdtemp(), "test_hoiku.db"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as hoiku  # noqa: E402


@pytest.fixture()
def client():
    hoiku.app.config["TESTING"] = True
    with hoiku.app.test_client() as c:
        yield c


def login(c, uid):
    return c.post("/api/login", json={"id": uid, "password": uid})


# ---------------------------------------------------------------- 月齢の算出
@pytest.mark.parametrize("birth,on,expected", [
    ("2025-04-10", "2025-04-10", 0),    # 生まれた日
    ("2025-04-10", "2025-05-09", 0),    # 応当日の前日
    ("2025-04-10", "2025-05-10", 1),    # 応当日
    ("2025-04-10", "2026-04-10", 12),   # 1歳の誕生日
    ("2026-01-31", "2026-02-28", 1),    # 応当日が無い月は、その月の末日を応当日とみなす
    ("2026-01-31", "2026-02-27", 0),    # 末日の前日はまだ迎えていない
    ("2026-01-31", "2026-03-31", 2),
    ("2024-02-29", "2025-02-28", 12),   # うるう日生まれの、うるう年でない年
    ("2024-02-29", "2025-02-27", 11),
    ("2025-04-10", "2025-04-01", 0),    # 生年月日より前は 0 に丸める
])
def test_months_between(birth, on, expected):
    assert hoiku.months_between(birth, on) == expected


# ---------------------------------------------------------------- 招待コード
def _issue(client, child_id=1, count=1):
    login(client, "encho")
    res = client.post("/api/invitations", json={"child_id": child_id, "count": count})
    assert res.status_code == 200
    client.post("/api/logout")
    return res.get_json()["codes"]


def test_old_shared_code_is_rejected(client):
    """以前の、全保護者で共用だった固定のコードでは登録できない"""
    res = client.post("/api/signup", json={"code": "HIVE-2026", "id": "old_user", "password": "pass1234"})
    assert res.status_code == 400
    assert "招待コードが正しくありません" in res.get_json()["error"]


def test_code_can_be_used_only_once(client):
    code = _issue(client)[0]
    first = client.post("/api/signup", json={"code": code, "id": "parent_once_1", "password": "pass1234"})
    assert first.status_code == 200
    client.post("/api/logout")
    second = client.post("/api/signup", json={"code": code, "id": "parent_once_2", "password": "pass1234"})
    assert second.status_code == 400
    assert "既に使用されています" in second.get_json()["error"]


def test_signup_links_guardian_to_child(client):
    code = _issue(client, child_id=2)[0]
    res = client.post("/api/signup", json={"code": code, "id": "parent_link", "password": "pass1234"})
    assert res.status_code == 200
    con = sqlite3.connect(hoiku.DB_PATH)
    try:
        rows = con.execute("SELECT child_id FROM guardian_children WHERE user_id='parent_link'").fetchall()
        used = con.execute("SELECT status, used_user_id FROM invitation_codes WHERE code=?", (code,)).fetchone()
    finally:
        con.close()
    assert rows == [(2,)]
    assert used == ("使用済み", "parent_link")


def test_two_codes_for_one_child_register_two_guardians(client):
    """1人の園児に複数の保護者が登録する場合は、必要な枚数を発行する"""
    a, b = _issue(client, child_id=3, count=2)
    assert a != b
    assert client.post("/api/signup", json={"code": a, "id": "parent_two_a", "password": "pass1234"}).status_code == 200
    client.post("/api/logout")
    assert client.post("/api/signup", json={"code": b, "id": "parent_two_b", "password": "pass1234"}).status_code == 200


def test_code_accepts_lowercase_and_missing_hyphens(client):
    code = _issue(client)[0]
    typed = code.replace("-", "").lower()
    res = client.post("/api/signup", json={"code": typed, "id": "parent_typed", "password": "pass1234"})
    assert res.status_code == 200


def test_revoked_code_is_rejected(client):
    code = _issue(client)[0]
    login(client, "encho")
    inv = next(i for i in client.get("/api/invitations").get_json()["invitations"] if i["code"] == code)
    assert client.post(f"/api/invitations/{inv['id']}/revoke").status_code == 200
    client.post("/api/logout")
    res = client.post("/api/signup", json={"code": code, "id": "parent_revoked", "password": "pass1234"})
    assert res.status_code == 400
    assert "失効" in res.get_json()["error"]


def test_expired_code_is_rejected(client):
    code = _issue(client)[0]
    con = sqlite3.connect(hoiku.DB_PATH)
    try:
        con.execute("UPDATE invitation_codes SET expires_on='2020-01-01' WHERE code=?", (code,))
        con.commit()
    finally:
        con.close()
    res = client.post("/api/signup", json={"code": code, "id": "parent_expired", "password": "pass1234"})
    assert res.status_code == 400
    assert "有効期限" in res.get_json()["error"]


def test_failed_signup_does_not_consume_code(client):
    """パスワードが短くて登録できなかったとき、コードは未使用のまま残る"""
    code = _issue(client)[0]
    bad = client.post("/api/signup", json={"code": code, "id": "parent_short", "password": "abc"})
    assert bad.status_code == 400
    ok = client.post("/api/signup", json={"code": code, "id": "parent_short", "password": "pass1234"})
    assert ok.status_code == 200


@pytest.mark.parametrize("uid", ["tanaka", "sato"])
def test_only_admin_manages_invitations(client, uid):
    login(client, uid)
    assert client.get("/api/invitations").status_code == 403
    assert client.post("/api/invitations", json={"child_id": 1}).status_code == 403
    assert client.post("/api/invitations/1/revoke").status_code == 403
