/*
 * 業務の流れのテスト
 * 典拠：基本設計書.md「日誌の作成から保護者への共有」(4-5)、「保護者アカウントの自己登録」(4-3)、
 *      「異常時の記録」(4-7)、5-2（招待コードは1枚＝1アカウント）
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { napAutoCloseAt, napTimerBase, today } from '../src/api/util';

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

describe('午睡チェック（基本設計書「午睡チェックの実施」(4-7)）', () => {
  it('体位・呼吸・顔色のどれかが選ばれていない記録は受け付けない', async () => {
    const s = await api.startSession(teacher, 1, today());
    const child = db.classChildren.find((cc) => cc.class_id === 1)!.child_id;
    const base = { child_id: child, body_position: '1', breathing: '1', complexion: '1', temperature: null } as const;
    await expect(api.record(teacher, s.nap_session_id, { ...base, breathing: '' as never })).rejects.toThrow(/呼吸/);
    await expect(api.record(teacher, s.nap_session_id, { ...base, complexion: '' as never })).rejects.toThrow(/顔色/);
    await expect(api.record(teacher, s.nap_session_id, { ...base, body_position: '' as never })).rejects.toThrow(/体位/);
    await expect(api.record(teacher, s.nap_session_id, base)).resolves.toBeTruthy();
  });

  it('タイマーの起点は、いちばん長く確認していない園児にする', () => {
    const start = '2026-09-01T13:00:00';
    // 未記録の園児がいるあいだは、開始時刻が起点のまま
    expect(napTimerBase(start, ['2026-09-01T13:10:00', null])).toBe(start);
    // 1人を記録し直しても、ほかの園児が古いままなら進まない
    expect(napTimerBase(start, ['2026-09-01T13:21:00', '2026-09-01T13:10:00'])).toBe('2026-09-01T13:10:00');
    // 全員を確認し終えると進む
    expect(napTimerBase(start, ['2026-09-01T13:21:00', '2026-09-01T13:20:00'])).toBe('2026-09-01T13:20:00');
    expect(napTimerBase(start, [])).toBe(start);
  });

  it('終了操作を忘れた実施は、午睡の時間帯の終了時刻で解除する', () => {
    expect(napAutoCloseAt('2026-09-01', '2026-09-01T13:00:00', '13:00-15:00')).toBe('2026-09-01T15:00:00');
    // 時間帯の終了より後に開始した実施は、その日の終わりに解除する（仮置き）
    expect(napAutoCloseAt('2026-09-01', '2026-09-01T16:10:00', '13:00-15:00')).toBe('2026-09-01T23:59:59');
  });

  it('解除の時刻を過ぎた実施は実施中でなくなり、自動で解除した印が付く', async () => {
    const stale = {
      nap_session_id: 990001, class_id: 3, session_date: '2020-01-06',
      started_staff_id: 'S003', started_at: '2020-01-06T13:00:00',
      ended_staff_id: null, ended_at: null, is_auto_closed: false,
    };
    db.napSessions.push(stale as never);
    expect(await api.activeSession(3, '2020-01-06')).toBeNull();
    const after = db.napSessions.find((x) => x.nap_session_id === 990001)!;
    expect(after.ended_at).toBe('2020-01-06T15:00:00');
    expect(after.is_auto_closed).toBe(true);
    expect(after.ended_staff_id).toBeNull();
  });
});

describe('発達チェックの確定（基本設計書「発達チェックの実施」(4-8)）', () => {
  const childId = 'C003';
  const checkedOn = today();

  it('所見は、確定したあとに開き直しても残っている', async () => {
    await api.saveCheck(teacher, childId, checkedOn, [], '歩き始めが安定してきた', '2');
    const again = await api.draftFor(childId, checkedOn);
    expect(again?.check.note).toBe('歩き始めが安定してきた');
  });

  it('確定すると、次回の予定日が実施日より先の日付になる', async () => {
    await api.saveCheck(teacher, childId, checkedOn, [], '', '2');
    const row = (await api.list(teacher, 1)).find((r) => r.child.child_id === childId)!;
    expect(row.lastCheckedOn).toBe(checkedOn);
    expect(row.scheduledOn! > checkedOn).toBe(true);
    expect(row.overdue).toBe(false);
  });

  it('未入力の項目を残して確定すると、一覧に未入力の件数が出る', async () => {
    const row = (await api.list(teacher, 1)).find((r) => r.child.child_id === childId)!;
    expect(row.unfilled).toBeGreaterThan(0);
  });

  it('実施日より先に手動で置いた予定は、確定しても動かさない', async () => {
    const other = 'C005';
    const before = db.developmentSchedules
      .filter((s) => s.child_id === other)
      .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))[0];
    const past = '2020-01-06';
    await api.saveCheck(teacher, other, past, [], '', '2');
    const after = db.developmentSchedules
      .filter((s) => s.child_id === other)
      .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))[0];
    expect(after.scheduled_on).toBe(before.scheduled_on);
    expect(after.is_manual_override).toBe(before.is_manual_override);
  });
});

describe('記録した職員の表示', () => {
  it('保護者が開く共有日誌には、記入者・確認者の氏名が載る（職員IDではない）', async () => {
    const shared = db.diaries.find((d) => !d.is_deleted && d.status === '3' && d.is_shared_to_guardian
      && d.child_id && db.guardianChildren.some((gc) =>
        gc.guardian_id === 'G001' && gc.child_id === d.child_id && gc.link_status === '1'))!;
    const d = await api.getDiary(guardian, shared.diary_id);
    expect(d.staff_name).toBeTruthy();
    expect(d.staff_name).not.toMatch(/^S\d+$/);
    expect(d.approved_staff_name).toBeTruthy();
    expect(d.approved_staff_name).not.toMatch(/^S\d+$/);
  });
});

describe('チャットツール（要件定義書「チャットツール」(4-3)）', () => {
  const personalRoom = 6; // 山田 太郎の保護者（個人チャット）
  const classRoom = 3;    // さくら組（クラスグループ。保護者も参加する）

  it('保護者も参加するチャンネルは、保護者の人数が分かる', async () => {
    const rooms = await api.rooms(teacher);
    expect(rooms.find((r) => r.room.chat_room_id === classRoom)!.guardianCount).toBeGreaterThan(0);
    // 職員チャットには保護者がいない
    expect(rooms.find((r) => r.room.room_type === '5')!.guardianCount).toBe(0);
    const members = await api.members(classRoom);
    expect(members.some((m) => m.role === '3')).toBe(true);
  });

  it('職員は個人チャットを対応済みにでき、保護者から受信すると未対応へ戻る', async () => {
    await api.setThreadStatus(teacher, personalRoom, '2');
    const status = async () =>
      (await api.rooms(teacher)).find((r) => r.room.chat_room_id === personalRoom)!.room.thread_status;
    expect(await status()).toBe('2');
    await api.send(guardian, personalRoom, '明日はお迎えが17時になります。');
    expect(await status()).toBe('1');
  });

  it('未対応／対応済みを切り替えられるのは職員だけで、個人チャットに限る', async () => {
    await expect(api.setThreadStatus(guardian, personalRoom, '2')).rejects.toThrow(/職員のみ/);
    await expect(api.setThreadStatus(teacher, classRoom, '2')).rejects.toThrow(/個人チャット/);
  });

  it('リアクションは職員も保護者も付けられ、同じ種別をもう一度選ぶと外れる', async () => {
    const target = (await api.messages(guardian, personalRoom)).find((m) => !m.is_deleted)!;
    await api.toggleReaction(guardian, target.chat_message_id, '1');
    await api.toggleReaction(teacher, target.chat_message_id, '1');
    let seen = (await api.messages(guardian, personalRoom)).find((m) => m.chat_message_id === target.chat_message_id)!;
    expect(seen.reactions).toEqual([{ reaction_type: '1', count: 2, mine: true }]);

    await api.toggleReaction(guardian, target.chat_message_id, '1');
    seen = (await api.messages(guardian, personalRoom)).find((m) => m.chat_message_id === target.chat_message_id)!;
    expect(seen.reactions).toEqual([{ reaction_type: '1', count: 1, mine: false }]);
  });

  it('保護者は自分の送ったメッセージを取り消せる。他人のものは取り消せない', async () => {
    const sent = await api.send(guardian, personalRoom, '送り間違えました');
    await api.retract(guardian, sent.chat_message_id);
    const after = (await api.messages(guardian, personalRoom)).find((m) => m.chat_message_id === sent.chat_message_id)!;
    expect(after.is_deleted).toBe(true);
    expect(after.body).toBe('');

    const fromStaff = (await api.messages(guardian, personalRoom))
      .find((m) => !m.is_deleted && m.sender_account_id !== guardian.account_id)!;
    await expect(api.retract(guardian, fromStaff.chat_message_id)).rejects.toThrow(/自分が送信した/);
  });
});

describe('利用規約の同意履歴（基本設計書「同意履歴（t_terms_agreement）」(5-2)）', () => {
  it('すでに同意しているアカウントには、履歴が1行ある', () => {
    const rows = db.termsAgreements.filter((x) => x.account_id === guardian.account_id);
    expect(rows.length).toBe(1);
  });

  it('同意すると履歴が1行増え、前の行は残る', async () => {
    // 最新版に同意していないアカウント（鈴木 美和）
    const u = await api.login('suzuki.m@example.jp', 'pass1234', 'guardian');
    const before = db.termsAgreements.filter((x) => x.account_id === u.account_id);
    await api.agreeTerms(u.account_id);
    const after = db.termsAgreements.filter((x) => x.account_id === u.account_id);
    expect(after.length).toBe(before.length + 1);
    for (const row of before) expect(after).toContainEqual(row);
    expect(db.accounts.find((a) => a.account_id === u.account_id)!.terms_version).toBe(db.CURRENT_TERMS_VERSION);
  });

  it('新規登録でも同意の履歴が残る', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C002', 30);
    const u = await api.signUpGuardian({
      code, email: 'rireki@example.jp', password: 'pass12345', guardian_name: '履歴 確認', relationship: '母',
    });
    expect(db.termsAgreements.filter((x) => x.account_id === u.account_id).length).toBe(1);
  });
});

describe('設計の決定を反映したもの（基本設計書 第2.3版）', () => {
  it('午睡チェックの間隔は、クラス名ではなくクラスの年齢児から引く', () => {
    const sakura = db.classes.find((c) => c.class_id === 1)!;
    const original = { name: sakura.class_name, age: sakura.age_class };
    try {
      sakura.class_name = 'たんぽぽ組';
      expect(api.intervalMinutesFor(1)).toBe(10); // 1歳児のまま
      sakura.age_class = 0;
      expect(api.intervalMinutesFor(1)).toBe(5);
      sakura.age_class = 4;
      expect(api.intervalMinutesFor(1)).toBe(15); // 2歳児以上は同じ値
    } finally {
      sakura.class_name = original.name;
      sakura.age_class = original.age;
    }
  });

  it('現在と同じパスワードへは変更できない', async () => {
    const u = await api.login('sato@hoiku.example.jp', 'temp0901', 'staff');
    await expect(api.changePassword(u.account_id, 'temp0901', 'temp0901')).rejects.toThrow(/現在と同じパスワード/);
    expect(db.accounts.find((a) => a.account_id === u.account_id)!.is_temp_password).toBe(true);
  });

  it('後から登録した保護者には、登録より前の個人チャットのやりとりを見せない', async () => {
    const before = (await api.messages(guardian, 6)).filter((m) => !m.is_deleted).length;
    expect(before).toBeGreaterThan(0);

    const code = await api.issueOneInvitationCode(admin, 'C001', 30);
    const grandma = await api.signUpGuardian({
      code, email: 'sobo@example.jp', password: 'pass12345', guardian_name: '山田 和子', relationship: '祖母',
    });
    // 登録した直後は、以前のやりとりが見えず、未読にも数えない
    expect(await api.messages(grandma, 6)).toHaveLength(0);
    expect((await api.rooms(grandma)).find((r) => r.room.chat_room_id === 6)!.unread).toBe(0);

    // 登録したあとのメッセージは見える
    await new Promise((r) => setTimeout(r, 1100));
    await api.send(teacher, 6, '明日の持ち物は水筒です。');
    const seen = await api.messages(grandma, 6);
    expect(seen.map((m) => m.body)).toEqual(['明日の持ち物は水筒です。']);

    // 先に登録していた保護者と職員は、これまでどおり全部読める
    expect((await api.messages(guardian, 6)).length).toBeGreaterThan(before);
    expect((await api.messages(teacher, 6)).length).toBeGreaterThan(before);
  });

  it('続柄は職員側のメンバー一覧にだけ出る', async () => {
    const forStaff = await api.members(6, teacher);
    expect(forStaff.find((m) => m.name === '山田 健一')!.relationship).toBe('父');
    expect(forStaff.find((m) => m.name === '山田 和子')!.relationship).toBe('祖母');
    const forGuardian = await api.members(6, guardian);
    expect(forGuardian.every((m) => m.relationship === null)).toBe(true);
  });

  it('園の電話番号は設定マスタから引ける', () => {
    expect(db.settings.find((s) => s.setting_key === 'facility.phone_number')!.setting_value).toBeTruthy();
  });
});

describe('園からの配布物（基本設計書「配布物の掲載と閲覧」(4-6)。GitHub Issue #94）', () => {
  const thisMonth = today().slice(0, 7);
  const input = {
    handout_type: '2', title: '来月の献立表', target_month: thisMonth, class_id: null as number | null,
    file_name: 'kondate.pdf', file_type: 'application/pdf', file_size: 200_000,
  };
  const admin3: SessionUser = { ...admin };

  it('保護者は、園全体向けと自児のクラス向けの配布物を、新しい月から順に見られる', async () => {
    const rows = await api.handouts(guardian);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((h) => h.handout_type === '1')).toBe(true);
    expect(rows.some((h) => h.handout_type === '2')).toBe(true);
    // 自児（さくら組）のクラスだよりは見える
    expect(rows.some((h) => h.class_id === 1)).toBe(true);
    const months = rows.map((h) => h.target_month);
    expect([...months].sort().reverse()).toEqual(months);
  });

  it('ほかのクラス向けの配布物は、そのクラスの保護者以外には見えない', async () => {
    const posted = await api.postHandout(admin3, { ...input, title: 'ひまわり組のお知らせ', handout_type: '4', class_id: 2 });
    expect((await api.handouts(guardian)).some((h) => h.handout_id === posted.handout_id)).toBe(false);
    // さくら組の担任にも見えない。管理者には見える
    expect((await api.handouts(teacher)).some((h) => h.handout_id === posted.handout_id)).toBe(false);
    expect((await api.handouts(admin3)).some((h) => h.handout_id === posted.handout_id)).toBe(true);
  });

  it('掲載できるのは管理者だけ', async () => {
    await expect(api.postHandout(teacher, input)).rejects.toThrow(/管理者のみ/);
    await expect(api.postHandout(guardian, input)).rejects.toThrow(/管理者のみ/);
  });

  it('PDF・JPEG・PNG 以外と、上限を超える大きさは掲載できない', async () => {
    await expect(api.postHandout(admin3, { ...input, file_name: 'a.docx', file_type: 'application/msword' }))
      .rejects.toThrow(/PDF・JPEG・PNG/);
    await expect(api.postHandout(admin3, { ...input, file_size: 11 * 1024 * 1024 })).rejects.toThrow(/10MB/);
    await expect(api.postHandout(admin3, { ...input, title: '  ' })).rejects.toThrow(/題名/);
    await expect(api.postHandout(admin3, { ...input, target_month: '2026-13' })).rejects.toThrow(/対象の月/);
  });

  it('掲載すると園チャットに知らせが流れ、保護者の一覧に出る', async () => {
    const posted = await api.postHandout(admin3, input);
    expect((await api.handouts(guardian)).some((h) => h.handout_id === posted.handout_id)).toBe(true);
    const notice = (await api.messages(guardian, 1)).find((m) => m.source_type === '4' && m.source_id === posted.handout_id);
    expect(notice?.body).toContain('来月の献立表');
  });

  it('取り下げると一覧から消える。取り下げられるのは管理者だけ', async () => {
    const posted = await api.postHandout(admin3, { ...input, title: '取り下げる配布物' });
    await expect(api.withdrawHandout(teacher, posted.handout_id)).rejects.toThrow(/管理者のみ/);
    await api.withdrawHandout(admin3, posted.handout_id);
    // 掲載の知らせも取り消される
    const notice = (await api.messages(guardian, 1)).find((m) => m.source_type === '4' && m.source_id === posted.handout_id)!;
    expect(notice.is_deleted).toBe(true);
    expect((await api.handouts(guardian)).some((h) => h.handout_id === posted.handout_id)).toBe(false);
    expect((await api.handouts(admin3)).some((h) => h.handout_id === posted.handout_id)).toBe(false);
  });

  it('種類で絞り込める', async () => {
    const rows = await api.handouts(guardian, { type: '2' });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((h) => h.handout_type === '2')).toBe(true);
  });
});
