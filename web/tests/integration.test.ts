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
    // 使用済みのコードをハイフンなし・小文字で入れる。「確認できません」ではなく「使われています」と返る
    await expect(http.api.verifyInvitationCode('ijkl5678mnop')).rejects.toThrow(/すでに使われています/);

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

  it('保護者が開く共有日誌には、記入者の氏名が載る（職員IDではない）', async () => {
    await switchTo('nohara.i@example.jp', 'pass1234', 'guardian');
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
      for (const jar of [staff, guardian, other]) await send('/api/logout', { method: 'POST', body: '{}' }, jar);
    }
  });
});
