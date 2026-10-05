/*
 * 業務の流れのテスト
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)、「保護者アカウントの自己登録」(4-3)、
 *      「異常時の記録」(4-7)、5-2（招待コードは1枚＝1アカウント）
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'takahashi@hoiku.example.jp', role: '1', display_name: '高橋 美咲',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
// 園チャットの相互編集を確かめるため、管理者をもう1人置く（基本設計書「メッセージの編集」(4-6)）
const admin2: SessionUser = {
  account_id: 2, email: 'suzuki@hoiku.example.jp', role: '1', display_name: '鈴木 一郎',
  staff_id: 'S002', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'yamada@hoiku.example.jp', role: '2', display_name: '山田 花子',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'yamada.k@example.jp', role: '3', display_name: '山田 健一',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('ログイン', () => {
  it('職員用の入口から保護者はログインできず、正しい入口を案内する', async () => {
    await expect(api.login('yamada.k@example.jp', 'pass1234', 'staff'))
      .rejects.toThrow(/wrong_entrance/);
  });

  it('保護者用の入口から職員はログインできない', async () => {
    await expect(api.login('yamada@hoiku.example.jp', 'pass1234', 'guardian'))
      .rejects.toThrow(/wrong_entrance/);
  });

  it('停止中のアカウントはログインできない', async () => {
    await expect(api.login('sato.n@example.jp', 'pass1234', 'guardian'))
      .rejects.toThrow(/suspended/);
  });

  it('一時パスワード中のアカウントは is_temp_password が真で返る', async () => {
    const u = await api.login('sato@hoiku.example.jp', 'temp0901', 'staff');
    expect(u.is_temp_password).toBe(true);
  });

  it('最新版の規約に同意していないアカウントは terms_agreed が偽で返る', async () => {
    const u = await api.login('suzuki.m@example.jp', 'pass1234', 'guardian');
    expect(u.terms_agreed).toBe(false);
  });

  it('職員のログインでは所属クラスが付く（共有端末での取り違えを防ぐため）', async () => {
    const u = await api.login('yamada@hoiku.example.jp', 'pass1234', 'staff');
    expect(u.class_name).toBe('さくら組');
  });
});

describe('日誌の作成から保護者への共有', () => {
  it('承認と共有の指定は別。共有しない承認では個人チャットへ流さない', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1,
      diary_date: '2026-09-02', body: '共有しない日誌',
    }, '2');
    const before = db.chatMessages.length;
    const approved = await api.approveDiary(admin, d.diary_id, false);

    expect(approved.status).toBe('3');
    expect(approved.is_shared_to_guardian).toBe(false);
    expect(approved.shared_at).toBeNull();
    expect(db.chatMessages.length).toBe(before);
  });

  it('共有する承認では個人チャットへ日誌の共有として流す', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1,
      diary_date: '2026-09-03', body: '共有する日誌',
    }, '2');
    await api.approveDiary(admin, d.diary_id, true);

    const msg = db.chatMessages.find((m) => m.source_type === '2' && m.source_id === d.diary_id);
    expect(msg).toBeDefined();
  });

  it('差し戻しは理由の入力を必須とする', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C001', class_id: 1,
      diary_date: '2026-09-04', body: '差し戻される日誌',
    }, '2');
    await expect(api.returnDiary(admin, d.diary_id, '  ')).rejects.toThrow('理由');

    const returned = await api.returnDiary(admin, d.diary_id, '記録が不足しています');
    expect(returned.status).toBe('4');
    expect(returned.returned_reason).toBe('記録が不足しています');
  });

  it('申請中でない日誌は承認できない', async () => {
    const d = await api.saveDiary(teacher, {
      record_type: '2', child_id: null, class_id: 1,
      diary_date: '2026-09-05', body: '下書きのまま',
    }, '1');
    await expect(api.approveDiary(admin, d.diary_id, false)).rejects.toThrow('申請中');
  });
});

/*
 * メッセージの編集
 * 典拠：基本設計書.md「メッセージの編集」(4-6)
 * 送信者本人のみ・回数と期限の制限なし・編集前の本文は操作ログへ・編集済みの印を残す
 */
describe('メッセージの編集', () => {
  /** 職員チャット（room_type=5）へ1件送り、その行を返す */
  const sendOwn = async (user: SessionUser, body: string) => {
    const room = db.chatRooms.find((r) => r.room_type === '5')!;
    await api.send(user, room.chat_room_id, body);
    const list = await api.messages(user, room.chat_room_id);
    /*
     * 末尾の1件ではなく本文で探す。デモデータの「今日」の投稿は時刻を持つため、
     * それより早い時刻に実行すると、いま送った行が末尾に来ない
     */
    return list.filter((m) => m.body === body).at(-1)!;
  };

  it('送信者本人は自分のメッセージを編集でき、編集済みの印が残る', async () => {
    const sent = await sendOwn(teacher, '明日の準備をお願いします');
    expect(sent.edited_at).toBeNull();

    await api.edit(teacher, sent.chat_message_id, '明後日の準備をお願いします');

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('明後日の準備をお願いします');
    expect(after.edited_at).not.toBeNull();
  });

  it('他人のメッセージは編集できない', async () => {
    const sent = await sendOwn(teacher, '他人には触らせない本文');
    await expect(api.edit(admin, sent.chat_message_id, '書き換え')).rejects.toThrow();

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('他人には触らせない本文');
  });

  it('編集前の本文を操作ログへ残す', async () => {
    const sent = await sendOwn(teacher, '編集前の本文');
    await api.edit(teacher, sent.chat_message_id, '編集後の本文');

    const log = db.operationLogs.find(
      (l) => l.target_table === 't_chat_message' && l.target_id === sent.chat_message_id
        && l.operation_type === '2',
    );
    expect(log).toBeDefined();
    expect(log!.before_value).toBe('編集前の本文');
    expect(log!.after_value).toBe('編集後の本文');
  });

  it('取り消したメッセージは編集できない', async () => {
    const sent = await sendOwn(teacher, '取り消す本文');
    await api.retract(teacher, sent.chat_message_id);
    await expect(api.edit(teacher, sent.chat_message_id, '書き換え')).rejects.toThrow('取り消した');
  });

  it('空の本文では編集できない', async () => {
    const sent = await sendOwn(teacher, '残る本文');
    await expect(api.edit(teacher, sent.chat_message_id, '   ')).rejects.toThrow();

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('残る本文');
  });

  it('回数の制限を設けない（続けて編集できる）', async () => {
    const sent = await sendOwn(teacher, '1回目');
    await api.edit(teacher, sent.chat_message_id, '2回目');
    await api.edit(teacher, sent.chat_message_id, '3回目');

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('3回目');
  });

  /** 指定した種別のチャンネルへ1件送り、その行を返す */
  const sendTo = async (user: SessionUser, roomType: string, body: string) => {
    const room = db.chatRooms.find((r) => r.room_type === roomType)!;
    await api.send(user, room.chat_room_id, body);
    const list = await api.messages(user, room.chat_room_id);
    /*
     * 末尾の1件ではなく本文で探す。デモデータの「今日」の投稿は時刻を持つため、
     * それより早い時刻に実行すると、いま送った行が末尾に来ない
     */
    return list.filter((m) => m.body === body).at(-1)!;
  };

  it('園全体・クラスグループ・個人チャットのいずれでも本人は編集できる', async () => {
    // 園全体は管理者だけが投稿できる。クラスグループと個人チャットは担任も投稿できる
    for (const [user, roomType] of [[admin, '1'], [teacher, '2'], [teacher, '4']] as const) {
      const sent = await sendTo(user, roomType, `${roomType} の本文`);
      await api.edit(user, sent.chat_message_id, `${roomType} の編集後`);

      const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
      expect(after.body).toBe(`${roomType} の編集後`);
      expect(after.edited_at).not.toBeNull();
    }
  });

  it('園チャットは管理者同士なら互いに編集できる', async () => {
    const sent = await sendTo(admin, '1', '9月の行事のお知らせ');
    await api.edit(admin2, sent.chat_message_id, '9月の行事のお知らせ（日程を訂正）');

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('9月の行事のお知らせ（日程を訂正）');
  });

  it('園チャットでも一般は他者のメッセージを編集できない', async () => {
    const sent = await sendTo(admin, '1', '管理者だけが直せるお知らせ');
    await expect(api.edit(teacher, sent.chat_message_id, '書き換え')).rejects.toThrow();

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('管理者だけが直せるお知らせ');
  });

  it('園チャット以外では、管理者でも他者のメッセージを編集できない', async () => {
    const sent = await sendTo(teacher, '4', '個人チャットの本文');
    await expect(api.edit(admin, sent.chat_message_id, '書き換え')).rejects.toThrow();

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('個人チャットの本文');
  });

  it('既読が付いたあとも編集できる（期限を設けない）', async () => {
    const sent = await sendTo(teacher, '4', '既読が付く前の本文');
    await api.markRead(guardian, sent.chat_room_id);
    expect(await api.readCount(sent.chat_message_id)).toBeGreaterThan(0);

    await api.edit(teacher, sent.chat_message_id, '既読が付いたあとの本文');

    const after = db.chatMessages.find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.body).toBe('既読が付いたあとの本文');
  });

  it('日誌の共有は、本文だけ編集でき、リンク先の記録は変わらない', async () => {
    // 日誌の共有（source_type=2）は個人チャットへ送られる（基本設計書「日誌の作成から保護者への共有」(4-5)）
    const shared = db.chatMessages.find((m) => m.source_type === '2')!;
    const sourceID = shared.source_id;

    await api.edit(teacher, shared.chat_message_id, '本日の日誌を共有しました。お目通しください。');

    const after = db.chatMessages.find((m) => m.chat_message_id === shared.chat_message_id)!;
    expect(after.body).toBe('本日の日誌を共有しました。お目通しください。');
    expect(after.source_type).toBe('2');
    expect(after.source_id).toBe(sourceID);
  });
});
