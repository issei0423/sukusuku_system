/*
 * 連絡帳の写真（モック）
 * 典拠：詳細設計書「きょうのようす」(4-4 (2))・(4-4 (3))・「写真」(3-3)・「テストの観点」(9-1) の「写真の同意」・
 *      「職員の画面から成長の記録へ届けるもの」(2-12 (1))、基本設計書「写真の同意で止める規則」(4-2)
 *
 * Go の同じ観点は server/api_contact_photo_test.go にある。実体の無いモックでは、同意と配信の判定だけを確かめる
 * （描き直して付帯情報を落とすのは画面とサーバ。決めたこと D-6）。文言は server/messages.go と同じ。
 * mockDb はこのファイルのテストで使い回す（前のテストの書き込みを当てにしない）。同意・設定を変えたら元へ戻す。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { api, connectLive } from '../src/api/client';
import { subscribeLive } from '../src/live';
import type { LiveSignal } from '../src/live';
import * as db from '../src/api/mockDb';
import { MSG } from '../src/messages';
import type { SessionUser, PhotoConsentLevel } from '../src/api/types';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const otherTeacher = user(5, '2', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const taroGuardian = user(6, '3', { guardian_id: 'G001' });
const misakiGuardian = user(9, '3', { guardian_id: 'G004' });

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach((s) => s()); });
function watch(viewer: SessionUser): LiveSignal[] {
  const got: LiveSignal[] = [];
  stops.push(connectLive(viewer.account_id));
  stops.push(subscribeLive((s) => got.push(s)));
  return got;
}

type Rejected = Error & { kind?: string; names?: string[]; matches?: { start: number; end: number }[] };
async function rejection(p: Promise<unknown>): Promise<Rejected> {
  try { await p; } catch (e) { return e as Rejected; }
  throw new Error('拒まれなかった');
}

/** 先頭のバイトが JPEG の写真（中身は小さな目印。モックは描き直さない） */
const jpeg = (extra = 0) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), new Uint8Array(extra)], { type: 'image/jpeg' });
const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])], { type: 'image/png' });

/** 同意を変えて fn を回し、元へ戻す */
async function withConsent(levels: Record<string, PhotoConsentLevel>, fn: () => Promise<void>): Promise<void> {
  const before = Object.keys(levels).map((id) => [id, db.children.find((c) => c.child_id === id)!.photo_consent_level] as const);
  for (const [id, lv] of Object.entries(levels)) db.children.find((c) => c.child_id === id)!.photo_consent_level = lv;
  try { await fn(); } finally {
    for (const [id, lv] of before) db.children.find((c) => c.child_id === id)!.photo_consent_level = lv;
  }
}

/** 設定を変えて fn を回し、元へ戻す */
async function withSetting(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const row = db.settings.find((s) => s.setting_key === key)!;
  const before = row.setting_value;
  row.setting_value = value;
  try { await fn(); } finally { row.setting_value = before; }
}

describe('写真を送る：検査の順（詳細設計書 (4-4 (2)) の表）', () => {
  it('大きさ：attachment.max_size_mb まで。写っている子が無くても大きさで先に止まる', async () => {
    await withSetting('attachment.max_size_mb', '1', async () => {
      await expect(api.sendPhoto(teacher, { file: jpeg(1024 * 1024), subject_child_ids: [] })).rejects.toThrow(MSG.photoFormat);
    });
  });

  it('形式：先頭のバイトで決める。申告した形式（image/jpeg）は使わない。設定に無い形式も断る', async () => {
    const gif = new Blob([new TextEncoder().encode('GIF89a')], { type: 'image/jpeg' });
    const text = new Blob([new TextEncoder().encode('これは写真ではありません')], { type: 'image/jpeg' });
    for (const file of [gif, text, new Blob([])]) {
      await expect(api.sendPhoto(teacher, { file, subject_child_ids: [] })).rejects.toThrow(MSG.photoFormat);
    }
    await withSetting('attachment.allowed_types', 'image/jpeg', async () => {
      await expect(api.sendPhoto(teacher, { file: png(), subject_child_ids: ['C001'] })).rejects.toThrow(MSG.photoFormat);
    });
  });

  it('写っている子が無く、届ける子も無い（または2人）なら送れない', async () => {
    for (const input of [{ subject_child_ids: [] }, { subject_child_ids: [' ', ''] }, { subject_child_ids: [], target_child_id: 'C001,C002' }]) {
      await expect(api.sendPhoto(teacher, { file: jpeg(), ...input })).rejects.toThrow(MSG.photoSubjectRequired);
    }
  });

  it('添える文は200文字まで', async () => {
    await expect(api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'], body: 'あ'.repeat(201) })).rejects.toThrow(MSG.commentTooLong);
  });

  it('書ける園児でなければ断る（無い園児と同じ文言）。同意より先に断る。フリーの職員は書けない', async () => {
    await withConsent({ C001: '1' }, async () => {
      await expect(api.sendPhoto(otherTeacher, { file: jpeg(), subject_child_ids: ['C001'] })).rejects.toThrow(MSG.contactForbidden);
      await expect(api.sendPhoto(taroGuardian, { file: jpeg(), subject_child_ids: ['C001'] })).rejects.toThrow();
      await expect(api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', 'C013'] })).rejects.toThrow(MSG.contactForbidden);
      await expect(api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: [], target_child_id: 'C999' })).rejects.toThrow(MSG.contactForbidden);
      const staff = db.classStaff.splice(db.classStaff.findIndex((s) => s.staff_id === 'S005'), 1);
      try {
        await expect(api.sendPhoto(otherTeacher, { file: jpeg(), subject_child_ids: ['C001'] })).rejects.toThrow(MSG.contactForbidden);
      } finally {
        db.classStaff.push(...staff);
      }
    });
  });
});

describe('写真の同意の3通り（基本設計書「写真の同意で止める規則」(4-2)）', () => {
  it('1人：同意 1 は断り、名前が入る。2 なら送れて、写っている子の行に送った時点の同意が写る', async () => {
    await withConsent({ C001: '1' }, async () => {
      await expect(api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'] }))
        .rejects.toThrow('西田 太郎さんは写真の同意が『園内記録として保持』のため送れません。写真を外すか、写っている子を見直してください。');
    });
    await withConsent({ C001: '2' }, async () => {
      const { photo, events } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'] });
      expect(events.map((e) => [e.child_id, e.event_type, e.contact_photo_id])).toEqual([['C001', '5', photo.contact_photo_id]]);
      expect(db.contactPhotoChildren.filter((c) => c.contact_photo_id === photo.contact_photo_id))
        .toEqual([{ contact_photo_id: photo.contact_photo_id, child_id: 'C001', consent_level: '2' }]);
    });
  });

  it('2人以上：1人でも 3 でなければ断り、満たさない子の名前が入る。全員 3 なら全員に届く', async () => {
    await withConsent({ C001: '3', C006: '1', C002: '2' }, async () => {
      const e = await rejection(api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', 'C006', 'C002'] }));
      expect(e.message).toBe('伊藤 葵さん・遠藤 花子さんは、ほかの保護者にも見える場への写真の同意がないため送れません。写真を外すか、写っている子を見直してください。');
    });
    await withConsent({ C001: '3', C006: '3' }, async () => {
      const before = db.contactPhotos.length;
      const { photo, events } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', ' C006'] });
      expect(db.contactPhotos.length).toBe(before + 1);
      expect(events.map((e) => e.child_id)).toEqual(['C001', 'C006']);
      expect(photo.subject_child_ids).toEqual(['C001', 'C006']);
      expect(events.every((e) => e.contact_photo_id === photo.contact_photo_id)).toBe(true);
    });
  });

  it('写っている子が0人：届ける子を1人選べば、同意に関わらず送れる。写っている子の行は作らず、操作ログに「なし」', async () => {
    await withConsent({ C004: '1' }, async () => {
      const { photo, events } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: [], target_child_id: 'C004' });
      expect(events.map((e) => e.child_id)).toEqual(['C004']);
      expect(photo.subject_child_ids).toEqual([]);
      const log = db.operationLogs.find((l) => l.target_table === 't_contact_photo' && l.target_id === photo.contact_photo_id && l.operation_type === '1');
      expect(log?.after_value).toMatch(/^\{"写っている子":"なし","届ける子":"C004"/);
    });
  });
});

describe('添える文の他児の名前は、届く家庭ごとに照合する（詳細設計書 (4-4 (2))・(4-5 (2)) の④）', () => {
  it('2人が写ると、もう1人の家庭に届く呼び名で注意が出る。承諾すれば送れる', async () => {
    await withConsent({ C001: '3', C006: '3' }, async () => {
      const body = 'たっくんがスコップで砂を運んでいました。';
      // 1人なら「たっくん」は宛先の子の呼び名で、注意は出ない
      await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'], body });
      const before = db.contactPhotos.length;
      const e = await rejection(api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', 'C006'], body }));
      expect([e.kind, e.names]).toEqual(['other_child_names', ['西田 太郎']]);
      expect(e.message).toContain('（2 家庭）');
      expect(e.matches?.map((m) => [m.start, m.end])).toEqual([[0, 4]]);
      expect(db.contactPhotos.length).toBe(before);
      const { events } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', 'C006'], body, acknowledged_names: ['西田 太郎'] });
      expect(events.map((x) => x.body)).toEqual([body, body]);
    });
  });
});

describe('成長の記録に残す（詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (1)) の「写真を送るとき」）', () => {
  // 付ける子を選ばせるかは【要決定】（要決定事項「決めてもらうこと」(1-3)）。Go の同じ観点は TestContactPhotoKeepInGrowthAllSubjects
  it('2人が写った写真に keep_in_growth を付けると、写っている子の全員の出来事に付く。付けなければどちらにも付かない', async () => {
    await withConsent({ C001: '3', C006: '3' }, async () => {
      const { photo, events } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', 'C006'], keep_in_growth: true });
      expect(events.map((e) => [e.child_id, e.keep_in_growth])).toEqual([['C001', true], ['C006', true]]);
      const rows = db.contactEvents.filter((e) => e.contact_photo_id === photo.contact_photo_id);
      expect(rows.map((e) => [e.child_id, e.keep_in_growth])).toEqual([['C001', true], ['C006', true]]);
      const logs = db.operationLogs.filter((l) => l.target_table === 't_contact_event' && l.operation_type === '1'
        && rows.some((e) => e.contact_event_id === l.target_id));
      expect(logs.map((l) => l.after_value?.includes('"keep_in_growth":true'))).toEqual([true, true]);

      const plain = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', 'C006'] });
      expect(plain.events.map((e) => e.keep_in_growth)).toEqual([false, false]);
    });
  });
});

describe('届く先と、写真の実体（詳細設計書 (4-4 (3))）', () => {
  it('写っている子の家庭にだけ知らせが届き、連絡帳に出来事として出る。写っている子は保護者に出さない', async () => {
    const misaki = watch(misakiGuardian);
    await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'], body: '砂場で型抜きをしました。', keep_in_growth: true });
    expect(misaki).toEqual([]);
    stops.splice(0).forEach((s) => s());
    const taro = watch(taroGuardian);
    const { photo, events } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'], keep_in_growth: true });
    expect(taro).toEqual([{ type: 'contact', child_id: 'C001' }]);
    expect(events[0].keep_in_growth).toBe(true);
    const page = await api.contactPage(taroGuardian, 'C001');
    expect(page.events.some((e) => e.event_type === '5' && e.contact_photo_id === photo.contact_photo_id)).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/subject/);
  });

  it('読める人にだけ URL を返す。ID を変えても、ほかの家庭・ほかのクラスの担任には返さない', async () => {
    const { photo } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'] });
    const id = photo.contact_photo_id;
    for (const who of [teacher, admin, taroGuardian]) {
      expect(typeof await api.photoUrl(who, id)).toBe('string');
    }
    for (const who of [misakiGuardian, otherTeacher]) {
      await expect(api.photoUrl(who, id)).rejects.toThrow(MSG.photoForbidden);
    }
    await expect(api.photoUrl(teacher, 99_999_999)).rejects.toThrow(MSG.photoForbidden);
    // フリーの職員は読める
    const staff = db.classStaff.splice(db.classStaff.findIndex((s) => s.staff_id === 'S005'), 1);
    try {
      expect(typeof await api.photoUrl(otherTeacher, id)).toBe('string');
    } finally {
      db.classStaff.push(...staff);
    }
  });

  it('保護者へ出す項目（contact.show_items）に photo が無ければ、保護者には返さない（職員には返す）', async () => {
    const { photo } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001'] });
    await withSetting('contact.show_items', 'nap,meal,toilet,temperature,comment,class', async () => {
      await expect(api.photoUrl(taroGuardian, photo.contact_photo_id)).rejects.toThrow(MSG.photoForbidden);
      expect(typeof await api.photoUrl(teacher, photo.contact_photo_id)).toBe('string');
    });
  });

  it('取り消した写真は、だれにも返さない。写っているほかの子の出来事もまとめて取り消す', async () => {
    await withConsent({ C001: '3', C006: '3' }, async () => {
      const { photo, events } = await api.sendPhoto(teacher, { file: jpeg(), subject_child_ids: ['C001', 'C006'] });
      await api.cancelEvent(teacher, events[0].contact_event_id);
      expect(db.contactPhotos.find((p) => p.contact_photo_id === photo.contact_photo_id)?.is_deleted).toBe(true);
      expect(db.contactEvents.filter((e) => e.contact_photo_id === photo.contact_photo_id).every((e) => e.is_deleted)).toBe(true);
      for (const who of [teacher, admin, taroGuardian]) {
        await expect(api.photoUrl(who, photo.contact_photo_id)).rejects.toThrow(MSG.photoForbidden);
      }
    });
  });
});
