# -*- coding: utf-8 -*-
"""身体記録APIのバリデーション・権限テスト

実行: hoiku_app ディレクトリで `pytest`
テスト用の一時DBを使うため、開発用の hoiku.db には影響しない。
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta

import pytest

# アプリ本体を import する前にテスト用DBパスを指定する
os.environ["HOIKU_DB"] = os.path.join(tempfile.mkdtemp(), "test_hoiku.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as hoiku  # noqa: E402


@pytest.fixture()
def client():
    hoiku.app.config["TESTING"] = True
    with hoiku.app.test_client() as c:
        yield c


def login(c, uid):
    return c.post("/api/login", json={"id": uid, "password": uid})


def _free_date(days_back=1):
    """シード済みデモ記録（毎月5日）と衝突しない過去日を返す"""
    d = datetime.now() - timedelta(days=days_back)
    while d.day == 5:
        days_back += 1
        d = datetime.now() - timedelta(days=days_back)
    return d.strftime("%Y-%m-%d")


# ---------------------------------------------------------------- バリデーション
def test_future_date_rejected(client):
    login(client, "tanaka")
    future = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    res = client.post("/api/physical/1", json={"measured_on": future, "height_cm": 75, "weight_kg": 9})
    assert res.status_code == 400
    assert "未来" in res.get_json()["error"]

def test_missing_date_rejected(client):
    login(client, "tanaka")
    res = client.post("/api/physical/1", json={"height_cm": 75, "weight_kg": 9})
    assert res.status_code == 400
    assert "測定日" in res.get_json()["error"]

def test_non_numeric_rejected(client):
    login(client, "tanaka")
    res = client.post("/api/physical/1", json={"measured_on": _free_date(), "height_cm": "abc", "weight_kg": 9})
    assert res.status_code == 400
    assert "数値" in res.get_json()["error"]

def test_missing_value_rejected(client):
    login(client, "tanaka")
    res = client.post("/api/physical/1", json={"measured_on": _free_date(), "height_cm": "", "weight_kg": 9})
    assert res.status_code == 400
    assert "必須" in res.get_json()["error"]

def test_out_of_range_requires_confirm(client):
    login(client, "tanaka")
    res = client.post("/api/physical/1", json={"measured_on": _free_date(), "height_cm": 200, "weight_kg": 9})
    assert res.status_code == 200
    assert res.get_json()["confirm"] == "range"

def test_overwrite_requires_confirm_separately_from_range(client):
    """範囲外の承諾（confirm_range）だけでは同日上書きが行われないこと（レビュー指摘1）"""
    login(client, "tanaka")
    day = _free_date(days_back=2)
    # 1回目: 正常登録
    res = client.post("/api/physical/1", json={"measured_on": day, "height_cm": 75.0, "weight_kg": 9.0})
    assert res.get_json().get("ok") is True
    # 2回目: 同日+範囲外。range を承諾しても overwrite の確認が別途返ること
    res = client.post("/api/physical/1", json={
        "measured_on": day, "height_cm": 200, "weight_kg": 9.0, "confirm_range": True})
    assert res.get_json()["confirm"] == "overwrite"
    # 3回目: 両方承諾で初めて上書きされる
    res = client.post("/api/physical/1", json={
        "measured_on": day, "height_cm": 200, "weight_kg": 9.0,
        "confirm_range": True, "confirm_overwrite": True})
    body = res.get_json()
    assert body.get("ok") is True
    assert any(r["measured_on"] == day and r["height_cm"] == 200.0 for r in body["records"])

def test_normal_register_and_overwrite_confirm(client):
    login(client, "tanaka")
    day = _free_date(days_back=3)
    res = client.post("/api/physical/2", json={"measured_on": day, "height_cm": 72.5, "weight_kg": 8.8})
    assert res.get_json().get("ok") is True
    # 同日再登録は上書き確認
    res = client.post("/api/physical/2", json={"measured_on": day, "height_cm": 72.6, "weight_kg": 8.9})
    assert res.get_json()["confirm"] == "overwrite"


# ---------------------------------------------------------------- 権限
def test_parent_gets_403(client):
    login(client, "sato")
    assert client.get("/api/physical/1").status_code == 403
    assert client.post("/api/physical/1", json={
        "measured_on": _free_date(), "height_cm": 75, "weight_kg": 9}).status_code == 403
    assert client.get("/api/growth_standards?sex=F&type=height").status_code == 403

def test_unauthenticated_gets_401(client):
    assert client.get("/api/physical/1").status_code == 401


# ---------------------------------------------------------------- 取得系
def test_get_records_and_standards(client):
    login(client, "tanaka")
    res = client.get("/api/physical/1")
    body = res.get_json()
    assert res.status_code == 200
    assert body["child"]["birth_date"]
    assert len(body["records"]) >= 1
    assert body["records"][0]["age_m"] is not None
    assert body["today"] == datetime.now().strftime("%Y-%m-%d")

    res = client.get("/api/growth_standards?sex=M&type=weight")
    stds = res.get_json()["standards"]
    assert len(stds) == 37 * 3  # 0〜36ヶ月 × 3パーセンタイル

def test_growth_standards_bad_params(client):
    login(client, "tanaka")
    assert client.get("/api/growth_standards?sex=X&type=height").status_code == 400
