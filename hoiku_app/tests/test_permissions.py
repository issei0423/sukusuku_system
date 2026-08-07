# -*- coding: utf-8 -*-
"""権限・参照範囲のテスト

テスト仕様書.md 3-3「権限・参照範囲（TC-PERM）」の16件に対応する。

対応する要件：
  - 8 セキュリティ要求 No.2 権限チェック
    「権限外の機能・データへのリクエストは拒否する。権限チェックは画面の
      出し分けだけに依存せず、サーバ側で強制する」
  - 8 セキュリティ要求 No.6 データ参照範囲の制限
  - 4-2 冒頭「対象権限列の読み方」

実行: hoiku_app ディレクトリで `pytest`
テスト用の一時DBを使うため、開発用の hoiku.db には影響しない。
"""
import os
import sys
import tempfile

import pytest

# アプリ本体を import する前にテスト用DBパスを指定する
os.environ["HOIKU_DB"] = os.path.join(tempfile.mkdtemp(), "test_perm.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as hoiku  # noqa: E402


@pytest.fixture()
def client():
    hoiku.app.config["TESTING"] = True
    with hoiku.app.test_client() as c:
        yield c


def login(c, uid):
    """デモアカウントでログインする（パスワードはIDと同じ）"""
    return c.post("/api/login", json={"id": uid, "password": uid})


# デモデータのチャンネル権限（app.py の seed() より）
#   id          admin   staff   parent
#   en          post    read    read
#   himawari    post    post    read
#   staffroom   post    post    none
#   dm_sakura   none    post    post


# ------------------------------------------------ 保護者が職員機能を使えないこと
def test_perm_001_parent_cannot_read_physical(client):
    """TC-PERM-001: 保護者は身体測定を参照できない"""
    login(client, "sato")
    res = client.get("/api/physical/1")
    assert res.status_code == 403


def test_perm_002_parent_cannot_post_physical(client):
    """TC-PERM-002: 保護者は身体測定を登録できない"""
    login(client, "sato")
    res = client.post(
        "/api/physical/1",
        json={"measured_on": "2026-01-15", "height_cm": 75, "weight_kg": 9},
    )
    assert res.status_code == 403


def test_perm_003_parent_cannot_toggle_nap(client):
    """TC-PERM-003: 保護者は午睡の状態を変更できない"""
    login(client, "sato")
    res = client.post("/api/nap/1/toggle")
    assert res.status_code == 403
    assert "権限" in res.get_json()["error"]


def test_perm_004_parent_cannot_edit_nap_memo(client):
    """TC-PERM-004: 保護者は午睡メモを編集できない"""
    login(client, "sato")
    res = client.post("/api/nap/1/memo", json={"memo": "テスト"})
    assert res.status_code == 403


def test_perm_005_parent_cannot_post_dev(client):
    """TC-PERM-005: 保護者は発達チェックを入力できない"""
    login(client, "sato")
    res = client.post("/api/dev/1", json={"item_id": 1, "result": "確認できた"})
    assert res.status_code == 403


def test_perm_006_parent_cannot_read_growth_standards(client):
    """TC-PERM-006: 保護者は成長曲線基準値を取得できない"""
    login(client, "sato")
    res = client.get("/api/growth_standards?sex=M&type=height")
    assert res.status_code == 403


# ------------------------------------------------ 操作ログは管理者のみ
def test_perm_007_staff_cannot_read_logs(client):
    """TC-PERM-007: 一般は操作ログを参照できない（4-1-4 (2) 権限）"""
    login(client, "tanaka")
    res = client.get("/api/logs")
    assert res.status_code == 403
    assert "権限" in res.get_json()["error"]


def test_perm_008_parent_cannot_read_logs(client):
    """TC-PERM-008: 保護者は操作ログを参照できない"""
    login(client, "sato")
    res = client.get("/api/logs")
    assert res.status_code == 403


def test_perm_009_admin_can_read_logs(client):
    """TC-PERM-009: 管理者は操作ログを参照できる"""
    login(client, "encho")
    res = client.get("/api/logs")
    assert res.status_code == 200
    assert isinstance(res.get_json()["logs"], list)


# ------------------------------------------------ 日誌の承認は管理者のみ
def test_perm_010_staff_cannot_approve_diary(client):
    """TC-PERM-010: 一般は日誌を承認できない（4-2 (1) 確認・承認）"""
    login(client, "tanaka")
    res = client.post("/api/nisshi/1/status", json={"status": "承認済み"})
    assert res.status_code == 403
    assert "管理者" in res.get_json()["error"]


def test_perm_011_parent_cannot_approve_diary(client):
    """TC-PERM-011: 保護者は日誌を承認できない"""
    login(client, "sato")
    res = client.post("/api/nisshi/1/status", json={"status": "承認済み"})
    assert res.status_code == 403


# ------------------------------------------------ チャンネルの権限
def test_perm_012_no_permission_channel_is_denied(client):
    """TC-PERM-012: 権限のないチャンネルのメッセージを取得できない

    保護者にとって staffroom（職員チャット）は perm='none'。
    """
    login(client, "sato")
    res = client.get("/api/channels/staffroom/messages")
    assert res.status_code == 403
    assert "権限" in res.get_json()["error"]


def test_perm_013_read_only_channel_rejects_post(client):
    """TC-PERM-013: 閲覧のみのチャンネルへ投稿できない

    保護者にとって en（園チャット）は perm='read'。読めるが書けない。
    """
    login(client, "sato")
    assert client.get("/api/channels/en/messages").status_code == 200

    res = client.post("/api/channels/en/messages", json={"body": "投稿できないはず"})
    assert res.status_code == 403
    assert "投稿できません" in res.get_json()["error"]


def test_perm_014_denied_even_without_ui(client):
    """TC-PERM-014: 画面を経由せず直接APIを叩いても拒否される

    8 No.2「権限チェックは画面の出し分けだけに依存せず、サーバ側で強制する」。
    保護者の画面に導線が無い操作を、APIへ直接送っても拒否されることを確認する。
    """
    login(client, "sato")
    cases = [
        ("post", "/api/physical/1", {"measured_on": "2026-01-15", "height_cm": 75, "weight_kg": 9}),
        ("post", "/api/nap/1/toggle", None),
        ("post", "/api/dev/1", {"item_id": 1, "result": "確認できた"}),
        ("post", "/api/nisshi/1/status", {"status": "承認済み"}),
        ("get", "/api/logs", None),
    ]
    for method, path, payload in cases:
        send = getattr(client, method)
        res = send(path, json=payload) if payload is not None else send(path)
        assert res.status_code == 403, f"{method.upper()} {path} が拒否されていない"


# ------------------------------------------------ 参照範囲（日誌の可視性）
def test_perm_015_parent_sees_only_approved_diary(client):
    """TC-PERM-015: 保護者に見える日誌は承認済みのみ

    4-2 (1)「保護者への共有」。未承認の日誌が保護者へ渡らないこと。
    """
    login(client, "sato")
    nisshi = client.get("/api/bootstrap").get_json()["nisshi"]
    assert nisshi, "検証対象の日誌が1件も無い（デモデータを確認すること）"
    assert all(n["status"] == "承認済み" for n in nisshi)


def test_perm_016_staff_sees_all_diary_statuses(client):
    """TC-PERM-016: 職員には全ステータスの日誌が見える"""
    login(client, "tanaka")
    nisshi = client.get("/api/bootstrap").get_json()["nisshi"]
    statuses = {n["status"] for n in nisshi}
    assert len(statuses) > 1, f"ステータスが1種類しかない: {statuses}"


# ------------------------------------------------ 補助: チャンネル一覧の出し分け
def test_channel_list_is_filtered_by_role(client):
    """TC-CHAT-006 相当: ロールごとに見えるチャンネルが変わる

    権限が 'none' のチャンネルは一覧に現れない。
    """
    login(client, "sato")
    parent_ids = {c["id"] for c in client.get("/api/bootstrap").get_json()["channels"]}
    assert "staffroom" not in parent_ids, "保護者に職員チャットが見えている"

    client.post("/api/logout")
    login(client, "tanaka")
    staff_ids = {c["id"] for c in client.get("/api/bootstrap").get_json()["channels"]}
    assert "staffroom" in staff_ids
