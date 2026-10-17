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
const taroGuardian = user(6, '3', { guardian_id: 'G001' }); // 野原 太郎（C001）の保護者。個人チャットは 6
const misakiGuardian = user(9, '3', { guardian_id: 'G004' }); // 宮城 美咲（C004）の保護者。個人チャットは 8

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach((s) => s()); });

/** viewer がこのタブでログインしているとして、届いた知らせを集める */
function watch(viewer: SessionUser): LiveSignal[] {
  const got: LiveSignal[] = [];
  stops.push(connectLive(viewer.account_id));
  stops.push(subscribeLive((s) => got.push(s)));
  return got;
}

describe('チャット', () => {
  it('個人チャットの送信は、その家庭の保護者にだけ届く（ほかの家庭には届かない）', async () => {
    const got = watch(misakiGuardian);
    await api.send(teacher, 6, '野原さんへの連絡です。');
    expect(got).toEqual([]);
    await api.send(teacher, 8, '宮城さんへの連絡です。');
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
  it('承認して共有すると、その園児の保護者に日誌と個人チャットの知らせが届く', async () => {
    // 日誌 7 は宮城 美咲（C004）の個人日誌（申請中）
    const misakiGot = watch(misakiGuardian);
    await api.approveDiary(admin, 7, true);
    expect(misakiGot).toEqual([{ type: 'chat', room_id: 8 }, { type: 'diary', diary_id: 7 }]);
  });

  it('ほかの家庭の日誌の申請・承認・共有は、保護者に届かない', async () => {
    const taroGot = watch(taroGuardian);
    const d = await api.saveDiary(teacher, {
      record_type: '1', child_id: 'C004', class_id: 1, diary_date: today(), body: '砂場で遊んだ。',
    }, '2');
    await api.approveDiary(admin, d.diary_id, true);
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
  it('開始・記録はその家庭の保護者にも届き、異常時の記録は職員にだけ届く', async () => {
    // デモの実施中の午睡チェックを終えておく（時刻によらず、開始から確かめるため）
    for (const classId of [1, 2]) {
      const s = await api.activeSession(classId, today(), admin);
      if (s) await api.endSession(admin, s.nap_session_id);
    }
    const taroGot = watch(taroGuardian);
    const session = await api.startSession(teacher, 1, today());
    expect(taroGot).toEqual([{ type: 'nap', class_id: 1 }]);

    const row = { body_position: '1', breathing: '1', complexion: '1', temperature: null } as const;
    await api.record(teacher, session.nap_session_id, { child_id: 'C004', ...row });
    expect(taroGot).toHaveLength(1);
    await api.record(teacher, session.nap_session_id, { child_id: 'C001', ...row });
    expect(taroGot[1]).toEqual({ type: 'nap', class_id: 1, child_id: 'C001' });

    await api.recordAbnormal(teacher, session.nap_session_id,
      { child_id: 'C001', found_at: '', situation: 'うつ伏せで寝ていた。', response: '仰向けに直した。' });
    expect(taroGot).toHaveLength(2);
    stops.splice(0).forEach((s) => s());

    // ほかのクラスの担任には届かない
    const otherGot = watch(otherTeacher);
    await api.record(teacher, session.nap_session_id, { child_id: 'C001', ...row });
    await api.endSession(teacher, session.nap_session_id);
    expect(otherGot).toEqual([]);
  });
});

describe('発達チェック・身体測定', () => {
  it('発達チェックは職員にだけ、身体測定は共有済みの測定値のときだけ保護者へも届く', async () => {
    const taroGot = watch(taroGuardian);
    await api.saveCheck(teacher, 'C001', today(), [], '', '1');
    await api.save(teacher, {
      child_id: 'C001', measured_on: addDays(today(), -1), height_cm: 79, weight_kg: 10, confirm_same_month: true,
    });
    expect(taroGot).toEqual([]);
    // 測定値 1 は野原 太郎の共有済みの測定値
    await api.remove(admin, 1);
    expect(taroGot).toEqual([{ type: 'physical', child_id: 'C001' }]);
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
    await api.setAccountStatus(admin, 9, '2');
    await api.send(teacher, 8, 'お熱は下がりましたか。');
    expect(got).toEqual([]);
  });
});
