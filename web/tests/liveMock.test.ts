/*
 * モックの書き込みのあとに、開いている画面へ同じ知らせを出すこと（api/mock.ts の publish）
 * 典拠：ナレッジ/決定事項.md 2026-10-15「相手の画面への反映は、SSE で即時にする」、
 *      web/仮置き値.md「開いたままの画面の読み直し（自動更新）」
 *
 * モックは1つのタブの中で動くため、知らせを受け取るのはそのタブでログインしている人（connectLive で渡す）だけである。
 * その人が、サーバ（server/events.go）と同じ判定で見てよい変化のときだけ知らせが出ることを確かめる。
 * サーバ側の同じ観点は server/events_test.go が確かめる。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { api, connectLive } from '../src/api/client';
import { subscribeLive } from '../src/live';
import type { LiveSignal } from '../src/live';
import type { SessionUser } from '../src/api/types';
import { today, addDays } from '../src/api/util';
import * as db from '../src/api/mockDb';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});

// デモデータの人物（mockDb.ts。server/seed.sql と同じ）
const admin = user(1, '1', { staff_id: 'S001' });
const admin2 = user(2, '1', { staff_id: 'S002' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' }); // さくら組の担任
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' }); // ひまわり組の担任
const taroGuardian = user(6, '3', { guardian_id: 'G001' }); // 西田 太郎（C001）の保護者。個人チャットは 6
const misakiGuardian = user(9, '3', { guardian_id: 'G004' }); // 村田 美咲（C004）の保護者。個人チャットは 8

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach((s) => s()); });

/** viewer がこのタブでログインしているとして、届いた知らせを集める */
/** 既存の日誌の保存に要る、本人の編集ロックの識別子（GitHub Issue #166） */
async function lockTokenOf(u: SessionUser, diaryId: number): Promise<string> {
  const r = await api.acquireLock(u, diaryId);
  if (!('token' in r)) throw new Error(`ロックを取れませんでした（${r.heldBy}さんが編集中）`);
  return r.token;
}

function watch(viewer: SessionUser): LiveSignal[] {
  const got: LiveSignal[] = [];
  stops.push(connectLive(viewer.account_id));
  stops.push(subscribeLive((s) => got.push(s)));
  return got;
}

describe('チャット', () => {
  it('個人チャットの送信は、その家庭の保護者にだけ届く（ほかの家庭には届かない）', async () => {
    const got = watch(misakiGuardian);
    await api.send(teacher, 6, '西田さんへの連絡です。');
    expect(got).toEqual([]);
    await api.send(teacher, 8, '村田さんへの連絡です。');
    expect(got).toEqual([{ type: 'chat', room_id: 8 }]);
  });

  it('未対応／対応済みは職員にだけ届く', async () => {
    const guardianGot = watch(taroGuardian);
    await api.setThreadStatus(teacher, 6, '2');
    expect(guardianGot).toEqual([]);
    stops.splice(0).forEach((s) => s());

    const adminGot = watch(admin);
    await api.setThreadStatus(teacher, 6, '1');
    expect(adminGot).toEqual([{ type: 'chat', room_id: 6 }]);
  });

  it('既読は、本人と（人数が変わるときだけ）職員に届く。新しく既読にしたものが無ければ出さない', async () => {
    await api.send(teacher, 6, '明日の持ち物です。');
    const adminGot = watch(admin);
    await api.markRead(taroGuardian, 6);
    expect(adminGot).toEqual([{ type: 'chat', room_id: 6 }]);
    await api.markRead(taroGuardian, 6);
    expect(adminGot).toHaveLength(1);
    // 職員が個人チャットを既読にしても、既読の人数（保護者だけを数える）は変わらない
    await api.send(taroGuardian, 6, '承知しました。');
    adminGot.length = 0;
    await api.markRead(teacher, 6);
    expect(adminGot).toEqual([]);
  });
});

describe('日誌', () => {
  it('承認は園内の確認で、その園児の保護者にも何も届かない（チャットの知らせも無い）', async () => {
    // 日誌 7 は村田 美咲（C004）の個人日誌（申請中）。日誌の知らせは保護者へ送らない
    // （詳細設計書「PR #196 からの変更」(6-1)・「日誌」(4-13 (2))）
    const misakiGot = watch(misakiGuardian);
    const approved = { ...(await api.approveDiary(admin, 7)) };
    expect(misakiGot).toEqual([]);

    // 承認の取り消しも、保護者には知らせず、職員にだけ知らせる（このタブは1人ずつしか見張れない）
    await api.revokeDiaryApproval(admin, 7, '確かめ直します', approved.updated_at);
    expect(misakiGot).toEqual([]);
    stops.splice(0).forEach((s) => s());
    const adminGot = watch(admin2);
    const again = await api.saveDiary(admin, {
      diary_id: 7, record_type: '1', child_id: 'C004', class_id: 1, diary_date: today(), body: '確かめ直した本文',
      lock_token: await lockTokenOf(admin, 7),
    }, '2');
    adminGot.length = 0;
    await api.approveDiary(admin2, again.diary_id);
    const approvedAgain = db.diaries.find((x) => x.diary_id === 7)!;
    await api.revokeDiaryApproval(admin, 7, 'もう一度確かめます', approvedAgain.updated_at);
    expect(adminGot).toEqual([{ type: 'diary', diary_id: 7 }, { type: 'diary', diary_id: 7 }]);
  });

  it('申請の取り下げは、参照できる職員に届き、保護者には届かない', async () => {
    // 日誌 2 はさくら組のクラス日誌（鈴木が申請中）
    const taroGot = watch(taroGuardian);
    const d = { ...(await api.getDiary(teacher, 2)) };
    await api.withdrawDiary(teacher, 2, d.updated_at);
    expect(taroGot).toEqual([]);
    stops.splice(0).forEach((s) => s());

    // 申請し直して、もう一度取り下げる。管理者には届く
    const adminGot = watch(admin);
    const again = { ...(await api.saveDiary(teacher, {
      diary_id: 2, record_type: '2', child_id: null, class_id: 1, diary_date: d.diary_date, body: d.body,
      lock_token: await lockTokenOf(teacher, 2),
    }, '2')) };
    adminGot.length = 0;
    await api.withdrawDiary(teacher, 2, again.updated_at);
    expect(adminGot).toEqual([{ type: 'diary', diary_id: 2 }]);
  });

  it('ほかの家庭の日誌の申請・承認は、保護者に届かない', async () => {
    const taroGot = watch(taroGuardian);
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C004', class_id: 1, diary_date: today(), body: '砂場で遊んだ。',
    }, '2');
    await api.approveDiary(admin, d.diary_id);
    expect(taroGot).toEqual([]);
  });

  it('差し戻しは、参照できる職員に届き、保護者には届かない', async () => {
    const teacherGot = watch(otherTeacher);
    await api.returnDiary(admin2, 6, '活動のねらいを具体的に書いてください。');
    expect(teacherGot).toEqual([{ type: 'diary', diary_id: 6 }]);
  });
});

describe('配布物', () => {
  it('クラス向けの掲載は、そのクラスの人にだけ届く', async () => {
    const otherGot = watch(otherTeacher);
    const input = {
      handout_type: '4', title: 'さくら組だより', target_month: '2026-10', class_id: 1,
      file_name: 'sakura.pdf', file_type: 'application/pdf', file_size: 1000,
    };
    await api.postHandout(admin, input);
    expect(otherGot).toEqual([]);
    stops.splice(0).forEach((s) => s());

    const guardianGot = watch(taroGuardian);
    const h = await api.postHandout(admin, { ...input, title: 'さくら組だより（訂正）' });
    expect(guardianGot).toEqual([{ type: 'handout', handout_id: h.handout_id }, { type: 'chat', room_id: 3 }]);
  });
});

describe('午睡チェック', () => {
  it('開始・5分ごとの確認・異常時の記録は職員にだけ届き、保護者には届かない（監査の層）', async () => {
    // デモの実施中の午睡チェックを終えておく（時刻によらず、開始から確かめるため）
    for (const classId of [1, 2]) {
      const s = await api.activeSession(classId, today(), admin);
      if (s) await api.endSession(admin, s.nap_session_id);
    }
    // 午睡（nap）の知らせは保護者へ送らない（詳細設計書「PR #196 からの変更」(6-1)）
    const taroGot = watch(taroGuardian);
    const session = await api.startSession(teacher, 1, today());
    const row = { body_position: '1', breathing: '1', complexion: '1', temperature: null } as const;
    await api.record(teacher, session.nap_session_id, { child_id: 'C001', ...row });
    await api.recordAbnormal(teacher, session.nap_session_id,
      { child_id: 'C001', found_at: '', situation: 'うつ伏せで寝ていた。', response: '仰向けに直した。' });
    expect(taroGot).toEqual([]);
    stops.splice(0).forEach((s) => s());

    const teacherGot = watch(teacher);
    await api.record(teacher, session.nap_session_id, { child_id: 'C004', ...row });
    expect(teacherGot).toEqual([{ type: 'nap', class_id: 1, child_id: 'C004' }]);
    stops.splice(0).forEach((s) => s());

    // ほかのクラスの担任には届かない
    const otherGot = watch(otherTeacher);
    await api.record(teacher, session.nap_session_id, { child_id: 'C001', ...row });
    await api.endSession(teacher, session.nap_session_id);
    expect(otherGot).toEqual([]);
  });
});

describe('連絡帳（ねた・おきた・家庭から）', () => {
  it('「ねた」「おきた」は、その家庭の保護者に contact だけが届き、ほかの家庭には何も届かない', async () => {
    for (const classId of [1, 2]) {
      const s = await api.activeSession(classId, today(), admin);
      if (s) await api.endSession(admin, s.nap_session_id);
    }
    const session = await api.startSession(teacher, 1, today());
    const taroGot = watch(taroGuardian);
    const slept = await api.sleep(teacher, session.nap_session_id, 'C001');
    expect(taroGot).toEqual([{ type: 'contact', child_id: 'C001' }]);
    await api.wake(teacher, slept.nap_sleep_id);
    expect(taroGot).toEqual([{ type: 'contact', child_id: 'C001' }, { type: 'contact', child_id: 'C001' }]);
    stops.splice(0).forEach((s) => s());

    const misakiGot = watch(misakiGuardian);
    await api.sleep(teacher, session.nap_session_id, 'C001');
    expect(misakiGot).toEqual([]);
    stops.splice(0).forEach((s) => s());

    // 職員（担任）には nap と contact の両方が届く。ほかのクラスの担任には届かない
    const teacherGot = watch(teacher);
    await api.sleep(teacher, session.nap_session_id, 'C002');
    expect(teacherGot).toEqual([{ type: 'nap', class_id: 1, child_id: 'C002' }, { type: 'contact', child_id: 'C002' }]);
    stops.splice(0).forEach((s) => s());
    const otherGot = watch(otherTeacher);
    await api.sleep(teacher, session.nap_session_id, 'C004');
    expect(otherGot).toEqual([]);
    await api.endSession(teacher, session.nap_session_id);
  });

  it('家庭からと確認しましたは、その家庭と担任に届く', async () => {
    const teacherGot = watch(teacher);
    const home = await api.saveHome(taroGuardian, 'C001', {
      temperature: null, night_sleep_from: null, night_sleep_to: null, breakfast: '1', mood_label: null,
      pickup_type: null, pickup_person: null, pickup_time: null, message: null,
      updated_at: (await api.contactPage(taroGuardian, 'C001')).home?.updated_at ?? null,
    });
    expect(teacherGot).toEqual([{ type: 'contact', child_id: 'C001' }]);
    stops.splice(0).forEach((s) => s());
    const taroGot = watch(taroGuardian);
    await api.confirmHome(teacher, home.contact_home_id, home.updated_at);
    expect(taroGot).toEqual([{ type: 'contact', child_id: 'C001' }]);
  });
});

describe('発達チェック・身体測定', () => {
  it('発達チェックの下書きは職員にだけ、確定は保護者へも。身体測定は共有するとき（設定）だけ保護者へも届く', async () => {
    const taroGot = watch(taroGuardian);
    const setting = db.settings.find((s) => s.setting_key === 'growth.share_physical')!;
    await api.saveCheck(teacher, 'C001', today(), [], '', '1');
    setting.setting_value = '0';
    try {
      await api.save(teacher, {
        child_id: 'C001', measured_on: addDays(today(), -1), height_cm: 79, weight_kg: 10, confirm_same_month: true,
      });
    } finally {
      setting.setting_value = '1';
    }
    expect(taroGot).toEqual([]);
    // 測定値 1 は西田 太郎の測定値。共有するので保護者へも届く
    await api.remove(admin, 1);
    expect(taroGot).toEqual([{ type: 'physical', child_id: 'C001' }]);
    // 確定は保護者の成長の記録に届くため、保護者へも送る（詳細設計書「知らせ」(6-2)）
    await api.saveCheck(teacher, 'C001', addDays(today(), -1), [], '', '2');
    expect(taroGot).toEqual([{ type: 'physical', child_id: 'C001' }, { type: 'development', child_id: 'C001' }]);
    stops.splice(0).forEach((s) => s());

    const teacherGot = watch(teacher);
    await api.saveCheck(teacher, 'C001', today(), [], '', '1');
    expect(teacherGot).toEqual([{ type: 'development', child_id: 'C001' }]);
  });
});

describe('受け取れない人', () => {
  it('ログインしていなければ出さない', async () => {
    const got: LiveSignal[] = [];
    stops.push(subscribeLive((s) => got.push(s)));
    await api.send(teacher, 8, 'お熱は下がりましたか。');
    expect(got).toEqual([]);
  });

  it('停止中の保護者には出さない', async () => {
    const got = watch(misakiGuardian);
    // 保護者は、手で停止せず、最後の紐づけの解除で止まる（基本設計書「アカウントの停止と再開」(4-3)）
    await api.endGuardianLink(admin, 'G004', 'C004');
    await api.send(teacher, 8, 'お熱は下がりましたか。');
    expect(got).toEqual([]);
  });
});
