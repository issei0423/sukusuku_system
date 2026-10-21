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
import { MSG } from '../src/messages';

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
/** 2つの端末（職員と保護者）を同時に動かすときに使う、手を加えていない fetch */
const realFetch = globalThis.fetch;
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

  /*
   * 別の端末でログインし直す。ログイン中は、系統・アカウントを問わず新しいログインを成立させない
   * （基本設計書「ログイン」(4-3)。GitHub Issue #159）ため、持っている Cookie を捨ててから入る
   */
  const switchTo = (email: string, password: string, entrance: 'staff' | 'guardian') => {
    cookie = '';
    return http.api.login(email, password, entrance);
  };

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
    const r = await http.api.acquireLock(dummy, 3);
    expect(r).toHaveProperty('heldBy', '宮城 蓮');
  });

  it('編集ロックは本人の識別子でだけ保存・操作の知らせ・解除ができ、状態に識別子は返らない（GitHub Issue #166）', async () => {
    // 日誌 1 は高梨（さくら組）の下書き。いまは高梨でログインしている
    const r = await http.api.acquireLock(dummy, 1);
    if (!('token' in r)) throw new Error(`ロックを取れませんでした（${r.heldBy}さんが編集中）`);
    expect(await http.api.lockOf(dummy, 1)).not.toHaveProperty('lock_token');

    await expect(http.api.touchLock(dummy, 1, 'lock-1-wrong')).rejects.toThrow(/編集ロックが解除されました/);
    await http.api.touchLock(dummy, 1, r.token);

    const d = await http.api.getDiary(dummy, 1);
    const input = {
      diary_id: 1, record_type: d.record_type, child_id: d.child_id, class_id: d.class_id,
      diary_date: d.diary_date, body: d.body,
    };
    await expect(http.api.saveDiary(dummy, input, '1')).rejects.toThrow(/編集ロックが解除されました/);
    await expect(http.api.saveDiary(dummy, { ...input, lock_token: r.token }, '1')).resolves.toMatchObject({ diary_id: 1 });

    // 識別子を添えない解除では外れず、本人の識別子で外れる
    await http.api.releaseLock(dummy, 1);
    expect(await http.api.lockOf(dummy, 1)).toMatchObject({ staff_name: '高梨 倫太朗' });
    await http.api.releaseLock(dummy, 1, false, r.token);
    expect(await http.api.lockOf(dummy, 1)).toBeNull();
  });

  it('日誌の写真は保存のときに日誌へ付き、空の並びで外れる（GitHub Issue #175 の 2）', async () => {
    // 日誌 1 は高梨（さくら組）の下書きで、写真は付いていない。終わったら元の 0 枚へ戻す
    const r = await http.api.acquireLock(dummy, 1);
    if (!('token' in r)) throw new Error(`ロックを取れませんでした（${r.heldBy}さんが編集中）`);
    const d = await http.api.getDiary(dummy, 1);
    const input = {
      diary_id: 1, record_type: d.record_type, child_id: d.child_id, class_id: d.class_id,
      diary_date: d.diary_date, body: d.body, lock_token: r.token,
    };
    try {
      await http.api.saveDiary(dummy, { ...input, attachments: [
        { file_path: 'demo/photo-it-1', file_type: 'image/jpeg' },
        { file_path: 'demo/photo-it-2', file_type: 'image/png' },
      ] }, '1');
      expect((await http.api.attachmentsOf(dummy, 1)).map((a) => [a.file_path, a.file_type])).toEqual([
        ['demo/photo-it-1', 'image/jpeg'], ['demo/photo-it-2', 'image/png'],
      ]);
      await expect(http.api.saveDiary(dummy, { ...input, attachments: [
        { file_path: 'demo/a.pdf', file_type: 'application/pdf' },
      ] }, '1')).rejects.toThrow(/JPEG・PNG/);
    } finally {
      await http.api.saveDiary(dummy, { ...input, attachments: [] }, '1');
      await http.api.releaseLock(dummy, 1, false, r.token);
    }
    expect(await http.api.attachmentsOf(dummy, 1)).toEqual([]);
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

  it('午睡チェックの記録の修正は、理由が無いと受け付けず、無い記録は「見つかりません」を返す（行も操作ログも変えない）', async () => {
    // 経路と送る形（POST /api/nap/records/{id}/correct、server/api_nap_correct.go）を、断られる要求だけで確かめる。
    // 直す要求はデモデータの記録と操作ログを書き換えて戻せないため、ここでは送らない（規則は server/api_nap_correct_test.go）
    await expect(http.api.correctNapRecord(dummy, 1, { body_position: '2', reason: '' })).rejects.toThrow(/修正の理由を入力してください/);
    await expect(http.api.correctNapRecord(dummy, 999999, { body_position: '2', reason: '確かめ' }))
      .rejects.toThrow(/午睡の記録が見つかりません/);
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

  it('届く人数とメンバー欄に停止中の保護者を入れず、送信者のロールを返し、参加中のグループだけを並べる（GitHub Issue #171・#172・#141）', async () => {
    const me = await http.api.bootstrap();
    const zen = (await http.api.rooms(dummy)).find((r) => r.room.room_type === '1')!;
    const members = await http.api.members(zen.room.chat_room_id);
    // デモの アカウント 8（高梨 倫太朗・保護者）は紐づけを終えて停止している
    expect(members.map((m) => m.account_id)).not.toContain(8);
    expect(zen.guardianCount).toBe(members.filter((m) => m.role === '3').length);

    const messages = await http.api.messages(dummy, zen.room.chat_room_id);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.sender_role === '1' || m.sender_role === '2' || m.sender_role === '3')).toBe(true);

    // 一般の職員には、いま参加している目的別グループだけが返る（モックの groups と同じ）
    for (const g of await http.api.groups(dummy)) {
      expect((await http.api.members(g.chat_room_id)).map((m) => m.account_id)).toContain(me!.account_id);
    }
  });

  it('招待コードはハイフンを省いても引ける。メールアドレスが空の登録は受け付けない', async () => {
    // 使用済みのコードをハイフンなし・小文字で入れる。「確認できません」ではなく使用済みの文が返る（基本設計書「メッセージ一覧」(4-12)）
    await expect(http.api.verifyInvitationCode('ijkl5678mnop')).rejects.toThrow(MSG.invitationUsed);

    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
    const code = await http.api.issueOneInvitationCode(dummy, 'C001', 30);
    const adminCookie = cookie;
    try {
      await expect(http.api.verifyInvitationCode(code.replace(/-/g, '').toLowerCase())).resolves.toBeTruthy();
      // 規約への同意（いまの版）を添える。同意の無い登録は受け付けない（GitHub Issue #170）
      const { terms_version } = await http.api.currentTerms();
      const base = { code, password: 'pass12345', guardian_name: '検査 太郎', relationship: '父', terms_agreed: true, terms_version };
      // ログイン中は新規登録を受け付けない（GitHub Issue #159）
      await expect(http.api.signUpGuardian({ ...base, email: 'taro@example.jp' })).rejects.toThrow(/already_logged_in/);
      // 登録は、ログインしていない端末から行う
      cookie = '';
      await expect(http.api.signUpGuardian({ ...base, email: '' })).rejects.toThrow(/メールアドレスを入力/);
      await expect(http.api.signUpGuardian({ ...base, email: 'taro.example.jp' })).rejects.toThrow(/形式/);
      // 規約に同意していない登録・大文字違いの既存のメールアドレスは受け付けない（GitHub Issue #170）
      await expect(http.api.signUpGuardian({ ...base, email: 'noagree@example.jp', terms_agreed: false }))
        .rejects.toThrow(/利用規約/);
      await expect(http.api.signUpGuardian({ ...base, email: 'NOHARA.I@EXAMPLE.JP' })).rejects.toThrow(/すでに登録/);
    } finally {
      cookie = adminCookie;
      const row = (await http.api.invitationCodes(dummy)).find((c) => c.code === code)!;
      await http.api.revokeInvitationCode(dummy, row.invitation_code_id);
    }
  });

  it('配布物を掲載すると保護者の一覧に出て、取り下げると消える', async () => {
    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
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

      await switchTo('nohara.i@example.jp', 'pass1234', 'guardian');
      expect((await http.api.handouts(dummy)).some((h) => h.handout_id === handout_id)).toBe(true);
      await expect(http.api.postHandout(dummy, {
        handout_type: '3', title: '保護者からは掲載できない', target_month: month, class_id: null,
        file_name: 'x.pdf', file_type: 'application/pdf', file_size: 100,
      })).rejects.toThrow(/管理者のみ/);
    } finally {
      await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
      await http.api.withdrawHandout(dummy, handout_id);
    }
    expect((await http.api.handouts(dummy)).some((h) => h.handout_id === handout_id)).toBe(false);
  });

  /*
   * 日誌は園内の記録で、保護者には返さない（詳細設計書「日誌」(4-13)）。以前の版で保護者へ共有した
   * 自児の承認済みの日誌（日誌 5）も、本物のサーバが 403 で断る。職員には作成者・承認者の氏名が載る
   */
  it('保護者には日誌を返さず、職員には作成者・承認者の氏名が載る（職員IDではない）', async () => {
    await switchTo('nohara.i@example.jp', 'pass1234', 'guardian');
    const home = await http.api.guardianHome(dummy);
    expect(home.every((h) => !('sharedDiaries' in h))).toBe(true);
    await expect(http.api.getDiary(dummy, 5)).rejects.toThrow('この日誌を参照する権限がありません');
    await expect(http.api.listDiaries(dummy, {})).rejects.toThrow('この日誌を参照する権限がありません');

    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
    const d = await http.api.getDiary(dummy, 5);
    expect(d.staff_name).toBeTruthy();
    expect(d.staff_name).not.toMatch(/^S\d+$/);
    expect(d.approved_staff_name).toBeTruthy();
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
    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
    expect(await http.api.bootstrap()).not.toBeNull();

    await http.api.logout();

    // 再読み込みに相当する。前の利用者として復元されない
    expect(await http.api.bootstrap()).toBeNull();
    // 参照表も捨てられている
    expect(http.visibleChildren(dummy)).toHaveLength(0);
  });

  /*
   * 一時パスワード中は、手続き以外の API を理由つきで拒否する（GitHub Issue #153）。
   * 参照表（/api/reference）も拒否されるため、ログインと開き直しが失敗しないことも確かめる。
   * パスワードは変えない。デモアカウントの一時パスワードを残すため。
   * ログアウトもしない。宮城 蓮が持っているデモの編集ロック（日誌2）が、ログアウトで外れるため
   */
  it('一時パスワード中でもログインでき、手続き以外の API は理由つきで拒否される', async () => {
    const procedure = await import('../src/api/procedure');
    const seen: string[] = [];
    const stop = procedure.onProcedureRequired((kind) => seen.push(kind));
    try {
      const u = await switchTo('miyagi@hoiku.example.jp', 'temp0901', 'staff');
      expect(u.is_temp_password).toBe(true);
      // 手続きを終えるまで、園児名などの参照表は持たない
      expect(http.visibleChildren(dummy)).toHaveLength(0);
      await expect(http.api.listChildren(dummy)).rejects.toMatchObject({ kind: 'password_change_required' });
      await expect(http.api.listChildren(dummy)).rejects.toThrow('パスワードを変更してください');
      expect(seen).toContain('password_change_required');
      // 開き直しても、手続きの途中として復元される（画面がパスワードの変更へ案内できる）
      expect((await http.api.bootstrap())?.is_temp_password).toBe(true);
    } finally {
      stop();
    }
  });

  /*
   * 自動ログアウトの予告と「続ける」（GitHub Issue #210）。期限はサーバが決めて返す。
   * 尋ねるだけでは延びず、「続ける」で延びる（server/api_session.go）。野原（S001）は午睡チェックを開始しないので、
   * 午睡の時間帯に回しても期限が返る
   */
  it('ログインの期限はサーバが返し、尋ねても延びず、「続ける」で延びる（GitHub Issue #210）', async () => {
    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
    try {
      const first = await http.api.sessionStatus(dummy);
      expect(first).toMatchObject({ auto_logout: true, nap_exempt: false });
      expect(first.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(first.remaining_seconds).toBeGreaterThan(29 * 60);
      expect(first.remaining_seconds).toBeLessThanOrEqual(30 * 60);

      await new Promise((r) => setTimeout(r, 1100));
      const asked = await http.api.sessionStatus(dummy);
      expect(asked.expires_at).toBe(first.expires_at);

      const extended = await http.api.extendSession(dummy);
      expect(extended.auto_logout).toBe(true);
      expect(extended.expires_at! > first.expires_at!).toBe(true);
    } finally {
      await http.api.logout();
    }
  });

  it('担当外の日誌の添付・編集ロック、園児の所属クラスは拒否される（GitHub Issue #153）', async () => {
    await switchTo('kinjo@hoiku.example.jp', 'pass1234', 'staff');
    try {
      await expect(http.api.attachmentsOf(dummy, 4)).rejects.toThrow(/権限がありません/);
      await expect(http.api.acquireLock(dummy, 1)).rejects.toThrow(/権限がありません/);
      await expect(http.api.lockOf(dummy, 2)).rejects.toThrow(/権限がありません/);
      await expect(http.api.classOf(dummy, 'C001')).rejects.toThrow(/権限がありません/);
      await expect(http.api.classOf(dummy, 'C013')).resolves.toBe(2);
    } finally {
      await http.api.logout();
    }
  });

  it('同じ氏名・生年月日の園児を引ける。CSV 一括登録の取込内容でも確認を促す（GitHub Issue #144 の 2）', async () => {
    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
    try {
      const c001 = await http.api.getChild(dummy, 'C001');
      expect((await http.api.sameNameBirthChildren(dummy, '野原　太郎', c001.birth_date)).map((c) => c.child_id))
        .toEqual(['C001']);
      expect(await http.api.sameNameBirthChildren(dummy, '野原 次郎', c001.birth_date)).toEqual([]);
      const { rows } = await http.api.parseChildCsv(
        `園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\nC501,野原 太郎,のはら たろう,${c001.birth_date},1,さくら組,36.5`);
      expect(rows[0].error).toBeNull();
      expect(rows[0].warning).toContain('C001');
    } finally {
      await http.api.logout();
    }
  });

  it('ログイン中は、別のアカウントのログインを成立させず、前のセッションを残す（GitHub Issue #159）', async () => {
    await switchTo('kinjo@hoiku.example.jp', 'pass1234', 'staff');
    await expect(http.api.login('nohara@hoiku.example.jp', 'pass1234', 'staff')).rejects.toThrow(/already_logged_in/);
    expect((await http.api.bootstrap())?.email).toBe('kinjo@hoiku.example.jp');
  });

  it('停止したアカウントのセッションは、その場で切れて画面へ知らせる（GitHub Issue #159）', async () => {
    const procedure = await import('../src/api/procedure');
    const kinjo = await switchTo('kinjo@hoiku.example.jp', 'pass1234', 'staff');
    const kinjoCookie = cookie;
    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
    const adminCookie = cookie;
    await http.api.setAccountStatus(dummy, kinjo.account_id, '2');
    try {
      cookie = kinjoCookie;
      let ended = 0;
      const stop = procedure.onSessionEnded(() => { ended += 1; });
      try {
        await expect(http.api.listChildren(dummy)).rejects.toThrow('ログインしていません');
        expect(ended).toBe(1);
        expect(http.visibleChildren(dummy)).toHaveLength(0);
      } finally {
        stop();
      }
    } finally {
      cookie = adminCookie;
      await http.api.setAccountStatus(dummy, kinjo.account_id, '1');
      await http.api.logout();
    }
  });

  /*
   * モック（web/tests/mockServerRules.test.ts）と同じ操作を、サーバに対して確かめる（GitHub Issue #177 の 3・7）。
   * 前回の発達チェック・当日の下書き・アレルギー一覧・異常時の記録・取消メッセージの一覧は、モックにだけ検査が無かった。
   * 並び順は web/仮置き値.md「一覧の並び順」
   */
  it('職員・管理者だけの一覧は保護者と担当外の職員に返さず、並び順はモックと同じ（GitHub Issue #177）', async () => {
    const todayJST = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

    await switchTo('nohara.i@example.jp', 'pass1234', 'guardian');
    await expect(http.api.previousCheck(dummy, 'C001', todayJST)).rejects.toThrow('職員のみが行えます');
    await expect(http.api.draftFor(dummy, 'C001', todayJST)).rejects.toThrow('職員のみが行えます');
    await expect(http.api.allAllergies(dummy)).rejects.toThrow('職員のみが行えます');
    await expect(http.api.abnormals(dummy)).rejects.toThrow('職員のみが行えます');
    await expect(http.api.retractedWithoutRecord(dummy)).rejects.toThrow('管理者のみ');

    // 金城（ひまわり組）は、さくら組の園児の発達チェックを読めない。アレルギー一覧は全園児をよみ順で返す
    await switchTo('kinjo@hoiku.example.jp', 'pass1234', 'staff');
    await expect(http.api.previousCheck(dummy, 'C001', todayJST)).rejects.toThrow('権限がありません');
    await expect(http.api.draftFor(dummy, 'C001', todayJST)).rejects.toThrow('権限がありません');
    expect((await http.api.allAllergies(dummy)).map((r) => r.child.child_id)).toEqual(['C013', 'C001', 'C020', 'C004']);

    // 招待コードは園児のよみ順にまとめ、同じ園児の中は発行の古い順（デモデータの 7 枚で見る）
    await switchTo('nohara@hoiku.example.jp', 'pass1234', 'staff');
    const codes = (await http.api.invitationCodes(dummy, {})).map((r) => r.invitation_code_id).filter((id) => id <= 7);
    expect(codes).toEqual([3, 4, 7, 5, 1, 2, 6]);
    const abnormals = await http.api.abnormals(dummy);
    for (let i = 1; i < abnormals.length; i++) expect(abnormals[i - 1].found_at >= abnormals[i].found_at).toBe(true);
    await http.api.logout();
  });

  /*
   * 記録してから、開いている保護者の画面に出るまで3秒以内（詳細設計書「3秒の目標を計る」(6-7)、決めたこと D-20）。
   * 保護者のセッションで GET /api/events を開いたまま、職員のセッションで「ねた」を押し、
   * 知らせ（contact）が届くまでと、続けて GET /api/contact/children/C001 が「おひるね中」を返すまでを計る。
   * ほかの家庭（宮城 美咲の保護者）には知らせが届かないことも確かめる
   */
  it('「ねた」を押してから3秒以内に、開いている保護者の画面に「おひるね中」が出る。ほかの家庭には届かない', async () => {
    const send = async (path: string, init: RequestInit = {}, jar?: string) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', BASE);
      if (init.body) headers.set('Content-Type', 'application/json');
      if (jar) headers.set('Cookie', jar);
      return realFetch(BASE + path, { ...init, headers });
    };
    const loginAs = async (email: string, entrance: 'staff' | 'guardian') => {
      const res = await send('/api/login', { method: 'POST', body: JSON.stringify({ email, password: 'pass1234', entrance }) });
      expect(res.status).toBe(200);
      return (res.headers.getSetCookie?.() ?? [])[0].split(';')[0];
    };
    const staff = await loginAs('takanashi@hoiku.example.jp', 'staff');
    const guardian = await loginAs('nohara.i@example.jp', 'guardian');
    const other = await loginAs('miyagi.r@example.jp', 'guardian');

    // さくら組の実施（無ければ始める）。野原 太郎がおひるね中なら、先に「おきた」にしておく
    const session = await (await send('/api/nap/session', { method: 'POST', body: JSON.stringify({ class_id: 1 }) }, staff)).json() as { nap_session_id: number };
    const before = await (await send('/api/contact/children/C001', {}, staff)).json() as { sleeps: { nap_sleep_id: number; woke_at: string | null; nap_session_id?: number }[] };
    for (const sl of before.sleeps.filter((x) => !x.woke_at && x.nap_session_id === session.nap_session_id)) {
      await send(`/api/nap/sleeps/${sl.nap_sleep_id}/wake`, { method: 'POST', body: '{}' }, staff);
    }

    const controller = new AbortController();
    const open = async (jar: string) => {
      const res = await send('/api/events', { signal: controller.signal }, jar);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      return {
        /** want を含む行が届くまで待つ。届かなければ ms で諦めて false */
        async waitFor(want: string, ms: number): Promise<boolean> {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            if (buffer.includes(want)) return true;
            const chunk = await Promise.race([
              reader.read(),
              new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now()))),
            ]);
            if (!chunk || chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
          return buffer.includes(want);
        },
      };
    };
    try {
      const guardianStream = await open(guardian);
      const otherStream = await open(other);
      await guardianStream.waitFor(': connected', 3000);
      await otherStream.waitFor(': connected', 3000);

      const started = Date.now();
      const res = await send(`/api/nap/session/${session.nap_session_id}/sleeps`, { method: 'POST', body: JSON.stringify({ child_id: 'C001' }) }, staff);
      expect(res.status).toBe(200);
      expect(await guardianStream.waitFor('data: {"type":"contact","child_id":"C001"}', 3000)).toBe(true);
      const page = await (await send('/api/contact/children/C001', {}, guardian)).json() as { sleeps: { woke_at: string | null }[] };
      const elapsed = Date.now() - started;
      expect(page.sleeps.some((x) => x.woke_at === null)).toBe(true);
      expect(elapsed).toBeLessThan(3000);
      console.log(`「ねた」から保護者の画面の読み直しまで ${elapsed} ミリ秒`);
      // ほかの家庭には、知らせ自体が届かない
      expect(await otherStream.waitFor('"child_id":"C001"', 500)).toBe(false);
    } finally {
      controller.abort();
      // 後のテストと手での確かめのために、「おきた」にして戻しておく
      const after = await (await send('/api/contact/children/C001', {}, staff)).json() as { sleeps: { nap_sleep_id: number; woke_at: string | null }[] };
      for (const sl of after.sleeps.filter((x) => !x.woke_at)) {
        await send(`/api/nap/sleeps/${sl.nap_sleep_id}/wake`, { method: 'POST', body: '{}' }, staff);
      }
      for (const jar of [staff, guardian, other]) await send('/api/logout', { method: 'POST', body: '{}' }, jar);
    }
  });
});

/*
 * きょうのようすの記録と、訂正・取り消しも、開いている保護者の画面に3秒以内に出る（詳細設計書「3秒の目標を計る」(6-7)）。
 * 排せつを記録 → 直す → 取り消すの3つで、知らせが届いて GET /api/contact/children/C001 が新しい内容を返すまでを計る。
 * ほかの家庭（宮城 美咲の保護者）には知らせが届かない
 */
run('結合：きょうのようすの記録・訂正・取り消しが3秒以内に届く', () => {
  const send = async (path: string, init: RequestInit = {}, jar?: string) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', BASE);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (jar) headers.set('Cookie', jar);
    return realFetch(BASE + path, { ...init, headers });
  };
  const loginAs = async (email: string, entrance: 'staff' | 'guardian') => {
    const res = await send('/api/login', { method: 'POST', body: JSON.stringify({ email, password: 'pass1234', entrance }) });
    expect(res.status).toBe(200);
    return (res.headers.getSetCookie?.() ?? [])[0].split(';')[0];
  };
  type Ev = { contact_event_id: number; toilet_label: string | null; corrected_at: string | null; updated_at?: string };

  it('排せつの記録・訂正・取り消しが、知らせと読み直しで3秒以内に保護者の画面に出る。ほかの家庭には届かない', async () => {
    const staff = await loginAs('takanashi@hoiku.example.jp', 'staff');
    const guardian = await loginAs('nohara.i@example.jp', 'guardian');
    const other = await loginAs('miyagi.r@example.jp', 'guardian');
    const controller = new AbortController();
    const open = async (jar: string) => {
      const res = await send('/api/events', { signal: controller.signal }, jar);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      return {
        /** want を含む知らせが届くまで待つ。待ち始める前に届いたものは数えないよう、確かめたら読み捨てる */
        async waitFor(want: string, ms: number): Promise<boolean> {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            if (buffer.includes(want)) { buffer = ''; return true; }
            const chunk = await Promise.race([
              reader.read(),
              new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now()))),
            ]);
            if (!chunk || chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
          const hit = buffer.includes(want);
          buffer = '';
          return hit;
        },
      };
    };
    const page = async () => (await (await send('/api/contact/children/C001', {}, guardian)).json()) as { events: Ev[] };
    const want = 'data: {"type":"contact","child_id":"C001"}';
    try {
      const guardianStream = await open(guardian);
      const otherStream = await open(other);
      await guardianStream.waitFor(': connected', 3000);
      await otherStream.waitFor(': connected', 3000);

      let started = Date.now();
      const recorded = await send('/api/contact/events', { method: 'POST', body: JSON.stringify({ items: [{ child_id: 'C001', event_type: '2', toilet_label: 'おしっこ' }] }) }, staff);
      expect(recorded.status).toBe(200);
      const [event] = ((await recorded.json()) as { events: Ev[] }).events;
      expect(await guardianStream.waitFor(want, 3000)).toBe(true);
      expect((await page()).events.some((e) => e.contact_event_id === event.contact_event_id)).toBe(true);
      const recordMs = Date.now() - started;

      started = Date.now();
      const corrected = await send(`/api/contact/events/${event.contact_event_id}/correct`,
        { method: 'POST', body: JSON.stringify({ toilet_label: 'うんち', updated_at: event.updated_at }) }, staff);
      expect(corrected.status).toBe(200);
      expect(await guardianStream.waitFor(want, 3000)).toBe(true);
      const fixed = (await page()).events.find((e) => e.contact_event_id === event.contact_event_id);
      expect([fixed?.toilet_label, !!fixed?.corrected_at]).toEqual(['うんち', true]);
      const correctMs = Date.now() - started;

      started = Date.now();
      expect((await send(`/api/contact/events/${event.contact_event_id}/cancel`, { method: 'POST', body: '{}' }, staff)).status).toBe(200);
      expect(await guardianStream.waitFor(want, 3000)).toBe(true);
      expect((await page()).events.some((e) => e.contact_event_id === event.contact_event_id)).toBe(false);
      const cancelMs = Date.now() - started;

      for (const ms of [recordMs, correctMs, cancelMs]) expect(ms).toBeLessThan(3000);
      console.log(`排せつの記録 ${recordMs}・訂正 ${correctMs}・取り消し ${cancelMs} ミリ秒で保護者の画面の読み直しまで`);
      // ほかの家庭には、知らせ自体が届かない。保護者の応答に職員の名前と読んだ版は入らない
      expect(await otherStream.waitFor('"child_id":"C001"', 500)).toBe(false);
      expect(JSON.stringify(await page())).not.toMatch(/staff_name|updated_at/);
    } finally {
      controller.abort();
      for (const jar of [staff, guardian, other]) await send('/api/logout', { method: 'POST', body: '{}' }, jar);
    }
  });

  /*
   * 写真（段2）：multipart/form-data で送ると、写っている子の家庭だけが実体を読める。見出しは no-store・nosniff。
   * 取り消すと、だれにも返さない（詳細設計書「きょうのようす」(4-4 (2))・(4-4 (3))）。デモの同意は全員 2（1人の写真は送れる）
   */
  it('写真を送ると、写っている子の家庭だけが実体を読める。取り消すと読めなくなる', async () => {
    // 2×2 の JPEG（サーバは読み直して描き直すため、本物の JPEG が要る）
    const tinyJpeg = Uint8Array.from(atob(
      '/9j/2wCEABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2MBERISGBUYLxoaL2NCOEJjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY//AABEIAAIAAgMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AJaKKK8s9U//2Q==',
    ), (c) => c.charCodeAt(0));
    const staff = await loginAs('takanashi@hoiku.example.jp', 'staff');
    const guardian = await loginAs('nohara.i@example.jp', 'guardian');
    const other = await loginAs('miyagi.r@example.jp', 'guardian');
    // multipart は境界の入った Content-Type を fetch に付けさせる（send は JSON の Content-Type を付けるため使わない）
    const sendForm = (form: FormData, jar: string) =>
      realFetch(BASE + '/api/contact/photos', { method: 'POST', body: form, headers: { Origin: BASE, Cookie: jar } });
    try {
      const form = new FormData();
      form.append('file', new Blob([tinyJpeg], { type: 'image/jpeg' }), 'photo.jpg');
      form.append('subject_child_ids', 'C001');
      form.append('body', '砂場で型抜きをしました。');
      const res = await sendForm(form, staff);
      expect(res.status).toBe(200);
      const sent = (await res.json()) as { photo: { contact_photo_id: number; file_type: string }; events: { contact_event_id: number; child_id: string }[] };
      expect([sent.photo.file_type, sent.events.map((e) => e.child_id)]).toEqual(['image/jpeg', ['C001']]);
      const path = `/api/contact/photos/${sent.photo.contact_photo_id}`;

      const mine = await send(path, {}, guardian);
      expect(mine.status).toBe(200);
      expect([mine.headers.get('content-type'), mine.headers.get('cache-control'), mine.headers.get('x-content-type-options')])
        .toEqual(['image/jpeg', 'private, no-store', 'nosniff']);
      expect((await mine.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await send(path, {}, other)).status).toBe(403);

      expect((await send(`/api/contact/events/${sent.events[0].contact_event_id}/cancel`, { method: 'POST', body: '{}' }, staff)).status).toBe(200);
      for (const jar of [staff, guardian]) expect((await send(path, {}, jar)).status).toBe(403);
    } finally {
      for (const jar of [staff, guardian, other]) await send('/api/logout', { method: 'POST', body: '{}' }, jar);
    }
  });

  /*
   * 園からのひとこと（段2）：他児の名前が入っていれば 409 other_child_names（names・matches）。承諾を付けて送ると、
   * 3秒以内に開いている保護者の画面に出る（詳細設計書「園からのひとことと他児の名前」(4-5)・(6-7)）。ほかの家庭には届かない
   */
  it('園からのひとことは他児の名前の注意を通り、承諾を付けて送ると3秒以内に保護者の画面に出る', async () => {
    const staff = await loginAs('takanashi@hoiku.example.jp', 'staff');
    const guardian = await loginAs('nohara.i@example.jp', 'guardian');
    const other = await loginAs('miyagi.r@example.jp', 'guardian');
    const controller = new AbortController();
    try {
      // 今日の園からが既にあれば取り消しておく（手での確かめのあとでも回せるように）
      const before = (await (await send('/api/contact/children/C001', {}, staff)).json()) as { facility: { contact_facility_id: number } | null };
      if (before.facility) await send(`/api/contact/facility/${before.facility.contact_facility_id}/cancel`, { method: 'POST', body: '{}' }, staff);
      const stream = async (jar: string) => {
        const res = await send('/api/events', { signal: controller.signal }, jar);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        return async (want: string, ms: number) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline && !buffer.includes(want)) {
            const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())))]);
            if (!chunk || chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
          const hit = buffer.includes(want);
          buffer = '';
          return hit;
        };
      };
      const guardianWait = await stream(guardian);
      const otherWait = await stream(other);
      await guardianWait(': connected', 3000);
      await otherWait(': connected', 3000);
      const body = 'あおちゃんとしゃぼん玉を追いかけていました。';
      const first = await send('/api/contact/children/C001/facility', { method: 'PUT', body: JSON.stringify({ body }) }, staff);
      expect(first.status).toBe(409);
      const err = (await first.json()) as { kind: string; names: string[]; matches: { start: number; end: number }[] };
      expect([err.kind, err.names, err.matches.map((m) => [m.start, m.end])]).toEqual(['other_child_names', ['伊藤 葵'], [[0, 5]]]);
      const started = Date.now();
      const sent = await send('/api/contact/children/C001/facility', { method: 'PUT', body: JSON.stringify({ body, acknowledged_names: err.names }) }, staff);
      expect(sent.status).toBe(200);
      expect(await guardianWait('data: {"type":"contact","child_id":"C001"}', 3000)).toBe(true);
      const page = (await (await send('/api/contact/children/C001', {}, guardian)).json()) as { facility: { body: string } | null };
      const elapsed = Date.now() - started;
      expect(page.facility?.body).toBe(body);
      expect(elapsed).toBeLessThan(3000);
      console.log(`園からのひとことから保護者の画面の読み直しまで ${elapsed} ミリ秒`);
      expect(await otherWait('"child_id":"C001"', 500)).toBe(false);
      expect(JSON.stringify(page)).not.toMatch(/staff_name|recipient|高梨/);
    } finally {
      controller.abort();
      for (const jar of [staff, guardian, other]) await send('/api/logout', { method: 'POST', body: '{}' }, jar);
    }
  });

  /*
   * AI 無しで動く（詳細設計書「テストでの差し替え」(8-11) の結合テスト、「キーが無い・無効・有効にしていないときの画面」(8-8)）。
   * 本物の AI は呼ばない。CI はキーを置かずにサーバを立てる。キーを置いて立てたサーバでは、キーが無いときの確かめを飛ばす
   */
  it('API キーが無いサーバでは、園が AI を有効にしてもボタンを出さず（status が偽）、下書きは 403。キーそのものは返さない', async () => {
    const admin = await loginAs('nohara@hoiku.example.jp', 'staff');
    const staff = await loginAs('takanashi@hoiku.example.jp', 'staff');
    type View = { read_at: string; ai_key_present: boolean; ai_key_rejected: boolean; settings: { setting_key: string; setting_value: string }[] };
    try {
      const forbidden = await send('/api/settings', {}, staff);
      expect(forbidden.status).toBe(403);
      const view = (await (await send('/api/settings', {}, admin)).json()) as View;
      expect(view.settings.map((x) => x.setting_key)).toEqual(['ai.daily_limit', 'ai.enabled']);
      expect(JSON.stringify(view)).not.toMatch(/sk-ant/);
      if (view.ai_key_present) {
        console.log('API キーを置いたサーバのため、キーが無いときの確かめを飛ばした');
        return;
      }
      const saved = await send('/api/settings', { method: 'POST', body: JSON.stringify({ changes: { 'ai.enabled': '1' }, read_at: view.read_at }) }, admin);
      expect(saved.status).toBe(200);
      expect(await (await send('/api/ai/status?child_id=C001', {}, staff)).json()).toEqual({ available: false });
      const { today } = await import('../src/api/util');
      const draft = await send('/api/ai/drafts', { method: 'POST', body: JSON.stringify({ purpose: 'facility_note', child_id: 'C001', date: today() }) }, staff);
      expect(draft.status).toBe(403);
      expect(((await draft.json()) as { message: string }).message).toBe('AI の下書きは使えません。そのまま書いて送れます。');
    } finally {
      const v = (await (await send('/api/settings', {}, admin)).json()) as View;
      await send('/api/settings', { method: 'POST', body: JSON.stringify({ changes: { 'ai.enabled': '0' }, read_at: v.read_at }) }, admin);
      for (const jar of [admin, staff]) await send('/api/logout', { method: 'POST', body: '{}' }, jar);
    }
  });
});
