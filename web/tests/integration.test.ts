/*
 * Go サーバとの結合テスト
 *
 * api/http.ts を実際のサーバへ向けて動かす。画面が使うのと同じ経路を通す。
 *
 * 既定では走らせない。サーバを起動したうえで、次のように環境変数を渡して実行する。
 *   server$ go run . -addr :8080
 *   web$    SUKUSUKU_API=http://localhost:8080 npx vitest run tests/integration.test.ts
 *
 * ふだんの npm test はブラウザ内のモックだけで完結させる（サーバに依存させない）。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

// 相手は本物の時計で動くサーバなので、tests/setup-clock.ts で止めた時計を本物に戻す
vi.useRealTimers();

const BASE = process.env.SUKUSUKU_API ?? '';
const run = BASE ? describe : describe.skip;

/*
 * node の fetch は Cookie を保持しない。
 * セッションの Cookie を手で持ち回し、相対パスへ基点を足す。
 *
 * あわせて Origin を添える。サーバは状態を変える要求の送信元を確かめており
 * （server/csrf.go）、ブラウザが自動で付けるものをここでは手で付ける。
 */
let cookie = '';
function useCookieJar() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input;
    const headers = new Headers(init?.headers);
    headers.set('Origin', BASE);
    if (cookie) headers.set('Cookie', cookie);
    const res = await real(url as RequestInfo, { ...init, headers });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set[0].split(';')[0];
    return res;
  };
}

run('Go サーバとの結合', () => {
  let http: typeof import('../src/api/http');

  beforeAll(async () => {
    useCookieJar();
    http = await import('../src/api/http');
  });

  const dummy = { account_id: 0 } as never;

  it('誤った系統の入口ではログインできない', async () => {
    await expect(http.api.login('nohara.i@example.jp', 'pass1234', 'staff'))
      .rejects.toThrow(/wrong_entrance/);
  });

  it('職員でログインすると所属クラスが付く', async () => {
    const u = await http.api.login('takanashi@hoiku.example.jp', 'pass1234', 'staff');
    expect(u.display_name).toBe('高梨 倫太朗');
    expect(u.class_name).toBe('さくら組');
    expect(u.role).toBe('2');
  });

  it('参照表が読み込まれ、同期の補助関数が引ける', () => {
    // 一般（さくら組担任）に見えるのは自クラスの12名
    expect(http.visibleChildren(dummy)).toHaveLength(12);
    expect(http.selectableClasses(dummy).map((c) => c.class_name)).toEqual(['さくら組']);
    expect(http.childName('C001')).toBe('野原 太郎');
    expect(http.className(1)).toBe('さくら組');
    expect(http.staffName('S003')).toBe('高梨 倫太朗');
    expect(http.settingNumber('ui.diary_lock_minutes', 0)).toBe(15);
  });

  it('自クラスの園児だけが参照範囲に入る', () => {
    expect(http.canSeeChild(dummy, 'C001')).toBe(true);
    expect(http.canSeeChild(dummy, 'C013')).toBe(false);
  });

  it('他クラスの園児を開くと拒否される', async () => {
    await expect(http.api.getChild(dummy, 'C013')).rejects.toThrow(/権限がありません/);
  });

  it('日誌の一覧がページングつきで返る', async () => {
    // デモデータは起動日に合わせて日付がずれる。固定の期間で探すと、作りたてのデータベースで
    // 0件になる（GitHub Issue #101）。今日から遡った期間で探す
    const day = (offset: number) => new Date(Date.now() + 9 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
    const p = await http.api.listDiaries(dummy, { from: day(-60), to: day(0) });
    expect(p.per_page).toBe(50);
    expect(p.rows.length).toBeGreaterThan(0);
    // 表示用の名前がサーバ側で解決されている
    expect(p.rows.every((d) => d.staff_name !== '')).toBe(true);
  });

  it('編集ロックを保持している日誌は、保持者の氏名が返る', async () => {
    const r = await http.api.acquireLock(dummy, 2);
    expect(r).toHaveProperty('heldBy', '宮城 蓮');
  });

  it('一般は園児を登録できない', async () => {
    await expect(http.api.saveChild(dummy, {
      child_id: 'C901', child_name: 'テスト', child_name_kana: 'てすと',
      birth_date: '2025-01-01', sex: '1', normal_temperature: null,
      photo_consent_level: '2', class_id: 1, allergies: [], medical_histories: [],
    }, 'create')).rejects.toThrow(/管理者のみ/);
  });

  it('月齢の区分は参照表から引ける', () => {
    expect(http.api.categoryFor(15)?.category_name).toBe('1歳3か月頃〜1歳6か月頃');
  });

  it('範囲外の測定値には注意喚起を返す（登録は妨げない）', () => {
    expect(http.api.rangeWarning(200, 10)).toContain('身長');
    expect(http.api.rangeWarning(80, 10)).toBeNull();
  });

  it('午睡チェックの間隔はクラスの年齢児から引ける', () => {
    expect(http.selectableClasses(dummy)[0].age_class).toBe(1);
    expect(http.api.intervalMinutesFor(1)).toBe(10);
  });

  it('園の電話番号が設定マスタにある', () => {
    expect(http.settingText('facility.phone_number', '')).not.toBe('');
  });

  it('メンバー一覧は、職員には保護者の続柄を返す', async () => {
    const personal = (await http.api.rooms(dummy)).find((r) => r.room.room_type === '4')!;
    const members = await http.api.members(personal.room.chat_room_id);
    const guardians = members.filter((m) => m.role === '3');
    expect(guardians.length).toBeGreaterThan(0);
    expect(guardians.every((m) => !!m.relationship)).toBe(true);
  });

  it('現在と同じパスワードへは変更できない', async () => {
    await expect(http.api.changePassword(0, 'pass1234', 'pass1234')).rejects.toThrow(/現在と同じパスワード/);
  });

  /*
   * ここから下は、ペルソナのデモで見つけた問題点の直しを、実サーバで確かめる
   * （GitHub Issue #74・#77・#79・#81・#82・#84・#85）。
   * デモデータを汚さないよう、変えた状態は各テストの中で元へ戻す。
   */
  it('午睡チェックの記録は、呼吸・顔色が選ばれていないと受け付けない', async () => {
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const existing = await http.api.activeSession(1, day);
    const s = existing ?? await http.api.startSession(dummy, 1, day);
    try {
      const base = { child_id: 'C001', body_position: '1', breathing: '1', complexion: '1', temperature: null };
      await expect(http.api.record(dummy, s.nap_session_id, { ...base, breathing: '' })).rejects.toThrow(/呼吸/);
      await expect(http.api.record(dummy, s.nap_session_id, { ...base, complexion: '' })).rejects.toThrow(/顔色/);
    } finally {
      if (!existing) await http.api.endSession(dummy, s.nap_session_id);
    }
  });

  it('成長曲線の基準値は、厚生労働省の公表値を返す（ブラウザ内のモックと同じ値）', async () => {
    const mock = await import('../src/api/mockDb');
    for (const sex of ['1', '2'] as const) {
      for (const measure of ['1', '2'] as const) {
        const rows = (await http.api.growthBand(sex, measure))!;
        expect(rows).toHaveLength(73 * 7);
        const expected = mock.growthStandards.filter((g) => g.sex === sex && g.measure_type === measure);
        const key = (g: { age_in_months: number; percentile: number }) => `${g.age_in_months}/${g.percentile}`;
        const want = new Map(expected.map((g) => [key(g), g]));
        for (const g of rows) {
          expect(g.standard_value).toBe(want.get(key(g))!.standard_value);
          expect(g.source_version).toBe(want.get(key(g))!.source_version);
        }
      }
    }
    // 表1 体重 男子 1年0～1月未満 の中央値
    const boysWeight = (await http.api.growthBand('1', '2'))!;
    expect(boysWeight.find((g) => g.age_in_months === 12 && g.percentile === 50)!.standard_value).toBe(9.24);
  });

  it('発達チェック一覧は、未入力の項目数を返す', async () => {
    const rows = await http.api.list(dummy, 1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => typeof r.unfilled === 'number')).toBe(true);
  });

  it('リアクションは付けて外せる', async () => {
    const rooms = await http.api.rooms(dummy);
    const room = rooms.find((r) => r.room.room_type === '2')!;
    expect(room.guardianCount).toBeGreaterThan(0);
    const target = (await http.api.messages(dummy, room.room.chat_room_id)).find((m) => !m.is_deleted)!;
    const find = async () => (await http.api.messages(dummy, room.room.chat_room_id))
      .find((m) => m.chat_message_id === target.chat_message_id)!.reactions!.find((r) => r.reaction_type === '4');

    const before = await find();
    await http.api.toggleReaction(dummy, target.chat_message_id, '4');
    const toggled = await find();
    expect(!!toggled?.mine).toBe(!before?.mine);
    await http.api.toggleReaction(dummy, target.chat_message_id, '4');
    expect(!!(await find())?.mine).toBe(!!before?.mine);
  });

  it('個人チャットを対応済みにして、未対応へ戻せる', async () => {
    const personal = (await http.api.rooms(dummy)).find((r) => r.room.room_type === '4')!;
    const id = personal.room.chat_room_id;
    const status = async () => (await http.api.rooms(dummy)).find((r) => r.room.chat_room_id === id)!.room.thread_status;
    const original = (await status()) === '1' ? '1' : '2';

    await http.api.setThreadStatus(dummy, id, '2');
    expect(await status()).toBe('2');
    await http.api.setThreadStatus(dummy, id, '1');
    expect(await status()).toBe('1');
    await http.api.setThreadStatus(dummy, id, original);
  });

  it('招待コードはハイフンを省いても引ける。メールアドレスが空の登録は受け付けない', async () => {
    // 使用済みのコードをハイフンなし・小文字で入れる。「確認できません」ではなく「使われています」と返る
    await expect(http.api.verifyInvitationCode('ijkl5678mnop')).rejects.toThrow(/すでに使われています/);

    await http.api.login('nohara@hoiku.example.jp', 'pass1234', 'staff');
    const code = await http.api.issueOneInvitationCode(dummy, 'C001', 30);
    try {
      await expect(http.api.verifyInvitationCode(code.replace(/-/g, '').toLowerCase())).resolves.toBeTruthy();
      const base = { code, password: 'pass12345', guardian_name: '検査 太郎', relationship: '父' };
      await expect(http.api.signUpGuardian({ ...base, email: '' })).rejects.toThrow(/メールアドレスを入力/);
      await expect(http.api.signUpGuardian({ ...base, email: 'taro.example.jp' })).rejects.toThrow(/形式/);
    } finally {
      const row = (await http.api.invitationCodes(dummy)).find((c) => c.code === code)!;
      await http.api.revokeInvitationCode(dummy, row.invitation_code_id);
    }
  });

  it('配布物を掲載すると保護者の一覧に出て、取り下げると消える', async () => {
    await http.api.login('nohara@hoiku.example.jp', 'pass1234', 'staff');
    const month = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
    const before = await http.api.handouts(dummy);
    expect(before.length).toBeGreaterThan(0);
    const { handout_id } = await http.api.postHandout(dummy, {
      handout_type: '3', title: '結合テストのお知らせ', target_month: month, class_id: null,
      file_name: 'test.pdf', file_type: 'application/pdf', file_size: 12_345,
    });
    try {
      await expect(http.api.postHandout(dummy, {
        handout_type: '3', title: '形式の誤り', target_month: month, class_id: null,
        file_name: 'a.docx', file_type: 'application/msword', file_size: 100,
      })).rejects.toThrow(/PDF・JPEG・PNG/);

      await http.api.login('nohara.i@example.jp', 'pass1234', 'guardian');
      expect((await http.api.handouts(dummy)).some((h) => h.handout_id === handout_id)).toBe(true);
      await expect(http.api.postHandout(dummy, {
        handout_type: '3', title: '保護者からは掲載できない', target_month: month, class_id: null,
        file_name: 'x.pdf', file_type: 'application/pdf', file_size: 100,
      })).rejects.toThrow(/管理者のみ/);
    } finally {
      await http.api.login('nohara@hoiku.example.jp', 'pass1234', 'staff');
      await http.api.withdrawHandout(dummy, handout_id);
    }
    expect((await http.api.handouts(dummy)).some((h) => h.handout_id === handout_id)).toBe(false);
  });

  it('保護者が開く共有日誌には、記入者の氏名が載る（職員IDではない）', async () => {
    await http.api.login('nohara.i@example.jp', 'pass1234', 'guardian');
    const home = await http.api.guardianHome(dummy);
    const shared = home.flatMap((h) => h.sharedDiaries)[0];
    expect(shared).toBeTruthy();
    const d = await http.api.getDiary(dummy, shared.diary_id);
    expect(d.staff_name).toBeTruthy();
    expect(d.staff_name).not.toMatch(/^S\d+$/);
  });

  /*
   * ログアウトはサーバ側のセッションを確実に捨てる。
   *
   * 以前は破棄の完了を待たずに画面を遷移していたため、全画面の読み込みで通信が打ち切られ、
   * サーバ側のセッションが生き残っていた。その状態で再読み込みすると、
   * 前の利用者としてログインし直ってしまう。共有端末では担当の取り違えになる
   * （基本設計書「画面基本構成」(3-5)）。
   */
  it('ログアウトするとサーバ側のセッションも捨てられる', async () => {
    await http.api.login('nohara@hoiku.example.jp', 'pass1234', 'staff');
    expect(await http.api.bootstrap()).not.toBeNull();

    await http.api.logout();

    // 再読み込みに相当する。前の利用者として復元されない
    expect(await http.api.bootstrap()).toBeNull();
    // 参照表も捨てられている
    expect(http.visibleChildren(dummy)).toHaveLength(0);
  });
});
