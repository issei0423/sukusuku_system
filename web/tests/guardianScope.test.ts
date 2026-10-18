/*
 * 保護者に見せる範囲（GitHub Issue #157）
 * 典拠：基本設計書.md「権限と利用可能機能」(6-1) ※3「自児のみ、かつ共有されたものに限る」・
 *      「権限チェックの実装方針」(6-2)、「日誌システム」(4-5)「共有を選べるのは個人日誌だけとする」、
 *      図/画面詳細図.md「共有日誌閲覧画面」(2-8)
 *
 * Go サーバ側（server/api_guardian_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * 業務の規則を2か所に持っているため、片方だけを直すと食い違う（MOCKUP.md）。
 */
import { describe, it, expect } from 'vitest';
import { api, childrenOfGuardian, selectableClasses, visibleChildren } from '../src/api/client';
import { GUARDIAN_SETTING_KEYS, referenceSettings } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const otherTeacher: SessionUser = {
  account_id: 5, email: 'kinjo@hoiku.example.jp', role: '2', display_name: '金城 宗一郎',
  staff_id: 'S005', guardian_id: null, class_id: 2, class_name: 'ひまわり組',
  is_temp_password: false, terms_agreed: true,
};
// 野原 太郎（C001・さくら組）の保護者
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
// 金城 陸（C005）の保護者。C005 には既往歴がある
const kinjoGuardian: SessionUser = {
  account_id: 10, email: 'kinjo.s@example.jp', role: '3', display_name: '金城 宗一郎',
  staff_id: null, guardian_id: 'G005', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('職員の編集画面・タイムラインの経路は、保護者に使わせない', () => {
  it('過去の記録・タイムラインは、保護者と担当外の職員には返さず、担任には返す', async () => {
    // 日誌 1 は C001 の下書き
    await expect(api.pastDiariesOf(guardian, 'C001')).rejects.toThrow();
    await expect(api.timelineOf(guardian, 'C001')).rejects.toThrow();
    await expect(api.pastDiariesOf(otherTeacher, 'C001')).rejects.toThrow('権限がありません');
    await expect(api.timelineOf(otherTeacher, 'C001')).rejects.toThrow('権限がありません');

    expect((await api.pastDiariesOf(teacher, 'C001')).some((d) => d.diary_id === 1)).toBe(true);
    expect((await api.timelineOf(teacher, 'C001')).some((d) => d.diary_id === 1)).toBe(true);
  });

  it('日誌の一覧も、保護者には承認済み・共有した自児の個人日誌だけを返す', async () => {
    const rows = (await api.listDiaries(guardian)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const d of rows) {
      expect(d.record_type).toBe('1');
      expect(d.status).toBe('3');
      expect(d.is_shared_to_guardian).toBe(true);
      expect(d.child_id).toBe('C001');
    }
  });
});

describe('共有を選べるのは個人日誌だけ（GitHub Issue #61・#157）', () => {
  it('ヒヤリハット・クラス日誌を共有つきで承認しようとすると断り、承認もしない', async () => {
    const incident = await api.saveDiary(teacher, {
      record_type: '4', child_id: 'C001', class_id: 1, diary_date: today(), body: '【状況】園内限定の記録',
    }, '2');
    for (const id of [incident.diary_id, 2]) { // 2 はさくら組のクラス日誌（申請中）
      await expect(api.approveDiary(admin, id, true)).rejects.toThrow('個人日誌だけです');
      const d = db.diaries.find((x) => x.diary_id === id)!;
      expect(d.status).toBe('2');
      expect(d.is_shared_to_guardian).toBe(false);
    }
    expect(db.chatMessages.some((m) => m.source_type === '2' && m.source_id === incident.diary_id)).toBe(false);

    // 共有しない承認は通る
    await expect(api.approveDiary(admin, incident.diary_id, false)).resolves.toBeTruthy();

    // すでに共有の印が付いてしまったヒヤリハットも、保護者には見せない
    db.diaries.find((x) => x.diary_id === incident.diary_id)!.is_shared_to_guardian = true;
    await expect(api.getDiary(guardian, incident.diary_id)).rejects.toThrow();
    const home = await api.guardianHome(guardian);
    expect(home.flatMap((h) => h.sharedDiaries).some((d) => d.diary_id === incident.diary_id)).toBe(false);
    expect((await api.listDiaries(guardian)).rows.some((d) => d.diary_id === incident.diary_id)).toBe(false);
  });
});

describe('園児情報・既往歴・アレルギーは保護者に見せない。身体測定は連携済だけ（基本設計書 6-1）', () => {
  it('自児でも、園児情報・既往歴・アレルギーは返さない。職員には返す', async () => {
    await expect(api.getChild(kinjoGuardian, 'C005')).rejects.toThrow();
    await expect(api.medicalHistoriesOf(kinjoGuardian, 'C005')).rejects.toThrow();
    await expect(api.allergiesOf(kinjoGuardian, 'C005')).rejects.toThrow();

    await expect(api.getChild(teacher, 'C005')).resolves.toBeTruthy();
    expect(await api.medicalHistoriesOf(teacher, 'C005')).toHaveLength(1);
    await expect(api.allergiesOf(teacher, 'C005')).resolves.toBeTruthy();
    // 担当外の職員には返さない
    await expect(api.medicalHistoriesOf(otherTeacher, 'C005')).rejects.toThrow('権限がありません');
    await expect(api.allergiesOf(otherTeacher, 'C005')).rejects.toThrow('権限がありません');
  });

  it('身体測定は、保護者には連携済の記録だけを返す。職員には全件', async () => {
    const mine = await api.recordsOf(guardian, 'C001');
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.share_status === '2')).toBe(true);
    expect(await api.recordsOf(teacher, 'C001')).toHaveLength(3);
  });
});

/*
 * 保護者には自児だけを返し、園児情報入力画面の項目（既往歴・アレルギー・写真の利用同意・平熱）は返さない
 * （図/インタフェース一覧.md「経路の一覧」(1)。設計の直しは PR #216 の直-30）。
 * サーバ側は server/api_guardian_test.go の TestGuardianChildIntakeItemsAreNotReturned
 */
describe('保護者に返す園児は自児だけで、園児情報入力画面の項目を載せない', () => {
  const INTAKE_KEYS = ['normal_temperature', 'photo_consent_level'];
  const noIntake = (where: string, value: unknown) => {
    const body = JSON.stringify(value);
    for (const k of INTAKE_KEYS) expect(body, `${where}: ${k}`).not.toContain(`"${k}"`);
    for (const s of ['除去食', '落花生', 'エピペン', '熱性けいれん', 'ぜんそく']) {
      expect(body, `${where}: ${s}`).not.toContain(s);
    }
  };

  it('自児・他児とも、園児の詳細・アレルギー・既往歴は返さない', async () => {
    for (const child of ['C001', 'C013', 'C999']) {
      await expect(api.getChild(guardian, child)).rejects.toThrow();
      await expect(api.allergiesOf(guardian, child)).rejects.toThrow();
      await expect(api.medicalHistoriesOf(guardian, child)).rejects.toThrow();
    }
  });

  it('園児の一覧は自児だけで、入力画面の項目を返さない。クラスや名前で絞っても広がらない', async () => {
    for (const filter of [{}, { classId: 1 }, { classId: 2 }, { name: '宮城' }]) {
      const rows = await api.listChildren(guardian, filter);
      noIntake(`listChildren ${JSON.stringify(filter)}`, rows);
      expect(rows.every((c) => c.child_id === 'C001')).toBe(true);
    }
    const [mine] = await api.listChildren(guardian);
    expect(mine.child_name).toBe('野原 太郎');
    expect(mine.birth_date).toBeTruthy();
    // 画面が同期的に引く自児（http.ts では /api/reference の children）にも載せない
    noIntake('visibleChildren', visibleChildren(guardian));
    noIntake('childrenOfGuardian', childrenOfGuardian('G001'));
  });

  it('保護者ホームの園児にも載せない', async () => {
    const home = await api.guardianHome(guardian);
    expect(home.map((h) => h.child.child_id)).toEqual(['C001']);
    noIntake('guardianHome', home.map((h) => h.child));
  });

  it('所属クラスは自児だけ', async () => {
    expect(await api.classOf(guardian, 'C001')).toBe(1);
    await expect(api.classOf(guardian, 'C013')).rejects.toThrow('権限がありません');
  });

  it('紐づけが終わった保護者には、元の自児も返さない', () => {
    // G003（高梨 倫太朗）は C003 との紐づけが終わっている。アカウントも停止中なので、API ではなく範囲の判定を見る
    const ended: SessionUser = { ...guardian, account_id: 8, guardian_id: 'G003', display_name: '高梨 倫太朗' };
    expect(visibleChildren(ended)).toEqual([]);
    expect(childrenOfGuardian('G003')).toEqual([]);
  });

  it('職員には、これまでどおり入力画面の項目を返す。モックのデータも書き換えない', async () => {
    for (const staff of [teacher, admin]) {
      const c = (await api.listChildren(staff)).find((x) => x.child_id === 'C001')!;
      expect(c).toHaveProperty('normal_temperature');
      expect(c).toHaveProperty('photo_consent_level');
      expect(await api.getChild(staff, 'C001')).toHaveProperty('photo_consent_level');
    }
    expect(db.children.find((c) => c.child_id === 'C001')).toHaveProperty('normal_temperature');
  });
});

describe('保護者が見られない日誌は「この記録は共有されていません」と示す（画面詳細図 2-8）', () => {
  it('自児の未共有・他児・無い日誌を同じ文言にし、職員にはこれまでどおり権限の文言を返す', async () => {
    for (const id of [1, 4, 99999]) { // 自児の下書き・他児の共有済み・無い日誌
      await expect(api.getDiary(guardian, id)).rejects.toThrow('この記録は共有されていません');
    }
    await expect(api.getDiary(otherTeacher, 1)).rejects.toThrow('この日誌を参照する権限がありません');
    await expect(api.getDiary(guardian, 5)).resolves.toBeTruthy();
  });
});

/*
 * 保護者へ返す参照データは、自児のクラスと、保護者の画面で使う設定だけ
 * （詳細設計書「参照データの設定の返し方」(4-10 (7))、決めたこと D-44。クラスを自児のものに絞るのは【仮置き】）。
 * サーバ側は server/api_guardian_test.go の TestGuardianReferenceIsNarrowed
 */
describe('保護者へ返す参照データは、自児のクラスと保護者の画面で使う設定だけ', () => {
  it('設定は保護者の画面で使うキーだけで、午睡の間隔などは返さない。職員には全キー', () => {
    const mine = referenceSettings(guardian);
    expect(Object.keys(mine).every((k) => GUARDIAN_SETTING_KEYS.has(k))).toBe(true);
    expect(mine['facility.name']).toBeTruthy();
    expect(mine['facility.phone_number']).toBeTruthy();
    for (const k of ['nap.interval_minutes.age0', 'nap.time_range', 'auth.max_failed_login', 'ui.diary_lock_minutes']) {
      expect(mine, k).not.toHaveProperty([k]);
    }
    for (const staff of [teacher, admin]) {
      expect(referenceSettings(staff)).toHaveProperty(['nap.interval_minutes.age0']);
    }
  });

  it('クラスは自児のクラスだけ。きょうだいが別のクラスにいれば両方、紐づけが終われば外れる', () => {
    expect(selectableClasses(guardian).map((c) => c.class_id)).toEqual([1]);
    const link = {
      guardian_id: 'G001', child_id: 'C013', relationship: '父', link_status: '1' as const,
      linked_at: '2026-04-01T09:00:00', ended_at: null as string | null,
    };
    db.guardianChildren.push(link);
    try {
      expect(selectableClasses(guardian).map((c) => c.class_id)).toEqual([1, 2]);
      Object.assign(link, { link_status: '2', ended_at: '2026-04-02T09:00:00' });
      expect(selectableClasses(guardian).map((c) => c.class_id)).toEqual([1]);
    } finally {
      db.guardianChildren.splice(db.guardianChildren.indexOf(link), 1);
    }
  });

  it('職員の選べるクラスは変えない', () => {
    expect(selectableClasses(teacher).map((c) => c.class_id)).toEqual([1]);
    expect(selectableClasses(admin).length).toBeGreaterThanOrEqual(3);
  });
});
