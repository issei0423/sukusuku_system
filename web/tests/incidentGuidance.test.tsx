// @vitest-environment jsdom
/*
 * 誤送信対応記録画面の案内（PR #216 の直-23）と、異常時の記録の「保護者への連絡」（PR #216 の画3）
 * 典拠：図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目5・項目8、
 *      要件定義書.md「チャットツール」(4-4) の誤送信の扱い（園の運用「情報が含まれていた園児の家庭への連絡」）、
 *      図/画面詳細図.md「異常時記録画面」(5-2) 項目13（午睡中の異常は電話で伝え（段4）、連絡帳・個人チャットは
 *      電話のあとに経過を書く手段）、基本設計書.md「異常時の記録」(4-8)・「入力項目の制約値」(4-12)
 *
 * 設計の直しは PR #216（design-v3-review-1018。未マージ）による。
 * 保護者への連絡の規則は、Go サーバ側（server/api_nap_guardian_notice_test.go）と同じ観点をモックに対して確かめる。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

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

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

afterEach(() => { cleanup(); });

describe('誤送信対応記録画面の案内（画面詳細図 4-4 項目5・項目8）', () => {
  it('受け取った家庭と、情報が含まれていた園児の家庭への連絡、園で判断したことを、とった対応に書くよう示す', async () => {
    // 対応の記録がない取消メッセージを1件置く（デモデータの取消は記録済みのため）
    db.chatMessages.push({
      chat_message_id: 990101, chat_room_id: 7, sender_account_id: 3, body: '', source_type: '1', source_id: null,
      sent_at: '2026-08-28T16:12:00', edited_at: null, is_deleted: true, deleted_at: '2026-08-28T16:14:00',
      deleted_account_id: 3,
    });
    open('/staff/admin/misdelivery', admin);
    await settled();
    fireEvent.click(await screen.findByText('対応を記録する'));

    // 項目8：注意書き。システムは判断しない旨に、連絡と判断を書くことを添える
    const note = await screen.findByText(/システムは判断しません/);
    expect(note.textContent).toContain('受け取った家庭と、情報が含まれていた園児の家庭への連絡を含めて記録してください。');
    expect(note.textContent).toContain('漏えいにあたるかどうか・報告が要るかどうかを園で判断したことも、とった対応に書いてください。');

    // 項目5：読まれていたときの注意。受け取った家庭だけでなく、情報が含まれていた園児の家庭も挙げる
    expect(document.body.textContent).not.toContain('目に触れた事実が消えません');
    fireEvent.click(screen.getByLabelText('既読が付いていた'));
    const alert = await screen.findByText(/目に触れた事実が消えません/);
    expect(alert.textContent).toContain('受け取った家庭と、情報が含まれていた園児の家庭への連絡を含めて対応を記録してください。');
  });
});

/*
 * 午睡の時間帯（13:00-15:00）の中に時計を置く。デモの実施が自動で解除されないようにするため
 * （napDevScreens.test.tsx と同じ）
 */
function atNapTime() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
  });
  afterEach(() => { vi.useRealTimers(); });
}

describe('異常時の記録の保護者への連絡（モックの規則）', () => {
  atNapTime();
  const base = { child_id: 'C001', situation: '顔色がやや紅潮', response: '別室で休ませた' };

  it('連絡の要否はシステムが判断しない。未記入でも「しない」でも記録でき、日時・手段・相手は持たない', async () => {
    const s = await api.startSession(teacher, 1, today());
    const found = `${today()}T13:00:00`;
    const blank = await api.recordAbnormal(teacher, s.nap_session_id, { ...base, found_at: found });
    const none = await api.recordAbnormal(teacher, s.nap_session_id, {
      ...base, found_at: found, guardian_notice: '2', guardian_noticed_at: found,
      guardian_notice_method: '1', guardian_notice_person: '母',
    });
    const stored = (id: number) => db.napAbnormals.find((a) => a.nap_abnormal_id === id)!;
    expect(stored(blank.nap_abnormal_id)).toMatchObject({
      guardian_notice: null, guardian_noticed_at: null, guardian_notice_method: null, guardian_notice_person: null,
    });
    expect(stored(none.nap_abnormal_id)).toMatchObject({
      guardian_notice: '2', guardian_noticed_at: null, guardian_notice_method: null, guardian_notice_person: null,
    });
  });

  it('「した」のときは日時・手段・相手が要り、日時の未来・形の崩れ、知らない手段、51文字の相手を断る', async () => {
    const s = await api.startSession(teacher, 1, today());
    const found = `${today()}T13:00:00`;
    const done = {
      guardian_notice: '1' as const, guardian_noticed_at: found,
      guardian_notice_method: '1' as const, guardian_notice_person: '母',
    };
    const before = db.napAbnormals.length;
    const cases = [
      { ...done, guardian_noticed_at: '' },
      { ...done, guardian_notice_method: '' as const },
      { ...done, guardian_notice_person: '　 ' },
      { ...done, guardian_noticed_at: '2999-01-01T10:00:00' },
      { ...done, guardian_noticed_at: 'abc' },
      { ...done, guardian_notice_method: '4' as never },
      { ...done, guardian_notice_person: '母'.repeat(51) },
      { guardian_notice: '3' as never },
    ];
    for (const c of cases) {
      await expect(api.recordAbnormal(teacher, s.nap_session_id, { ...base, found_at: found, ...c }))
        .rejects.toThrow('保護者');
    }
    expect(db.napAbnormals.length).toBe(before);
  });

  it('「した」は日時・手段・相手を残し、一覧で返す。電話のあとに経過を書いた連絡帳・個人チャットも手段に選べる', async () => {
    const s = await api.startSession(teacher, 1, today());
    const found = `${today()}T13:00:00`;
    const person = '母'.repeat(49) + '）';
    const phone = await api.recordAbnormal(teacher, s.nap_session_id, {
      ...base, found_at: found, guardian_notice: '1', guardian_noticed_at: found,
      guardian_notice_method: '1', guardian_notice_person: ` ${person} `,
    });
    const book = await api.recordAbnormal(teacher, s.nap_session_id, {
      ...base, found_at: found, guardian_notice: '1', guardian_noticed_at: found,
      guardian_notice_method: '3', guardian_notice_person: '父',
    });
    const list = await api.abnormals(teacher);
    expect(list.find((a) => a.nap_abnormal_id === phone.nap_abnormal_id)).toMatchObject({
      guardian_notice: '1', guardian_noticed_at: found, guardian_notice_method: '1', guardian_notice_person: person,
    });
    expect(list.find((a) => a.nap_abnormal_id === book.nap_abnormal_id)!.guardian_notice_method).toBe('3');
    // 列を足す前のデモデータは未記入として返す（サーバは空の列を null で返す）
    expect(list.find((a) => a.nap_abnormal_id === 2)).toMatchObject({
      guardian_notice: null, guardian_noticed_at: null, guardian_notice_method: null, guardian_notice_person: null,
    });
  });
});

describe('異常時の記録の保護者へ連絡した日時と発見時刻の前後（【仮置き】web/仮置き値.md。PR #229 で頭役が決めた）', () => {
  atNapTime();
  const base = { child_id: 'C001', situation: '顔色がやや紅潮', response: '別室で休ませた' };

  it('発見より前に連絡することはないため、ちょうど発見時刻は通し、1分前は断る', async () => {
    const s = await api.startSession(teacher, 1, today());
    const found = `${today()}T13:00:00`;
    const notice = (at: string) => ({
      ...base, found_at: found, guardian_notice: '1' as const, guardian_noticed_at: at,
      guardian_notice_method: '1' as const, guardian_notice_person: '母',
    });
    const before = db.napAbnormals.length;
    await expect(api.recordAbnormal(teacher, s.nap_session_id, notice(`${today()}T12:59:00`)))
      .rejects.toThrow('発見時刻より前');
    expect(db.napAbnormals.length).toBe(before);
    const same = await api.recordAbnormal(teacher, s.nap_session_id, notice(found));
    expect(db.napAbnormals.find((a) => a.nap_abnormal_id === same.nap_abnormal_id)!.guardian_noticed_at).toBe(found);
  });
});

describe('異常時記録画面の保護者への連絡（画面詳細図 5-2 項目13）', () => {
  atNapTime();

  it('電話を先頭に置き、連絡帳・個人チャットは電話のあとに経過を書く手段と示す。「した」なら日時・手段・相手を残す', async () => {
    await api.startSession(teacher, 1, today());
    open('/staff/nap/abnormal', teacher);
    await settled();

    // 説明の文は、した／しないを選ぶ前から出す
    expect(document.body.textContent).toContain(
      '午睡中の異常は、電話で保護者へ伝えてください。連絡帳・個人チャットは、電話のあとに経過を書くときに使います。');
    expect(screen.queryByLabelText('手段')).toBeNull();

    const childSelect = Array.from(document.querySelectorAll('select'))
      .find((x) => Array.from(x.options).some((o) => o.textContent === '選んでください'))!;
    fireEvent.change(childSelect, { target: { value: 'C006' } });
    const [situation, response] = Array.from(document.querySelectorAll('textarea'));
    fireEvent.change(situation, { target: { value: '呼吸の確認に時間がかかった' } });
    fireEvent.change(response, { target: { value: '体を起こして呼吸を確かめた' } });
    const record = screen.getByText('記録する') as HTMLButtonElement;
    expect(record.disabled).toBe(false); // 保護者への連絡は未記入のままでも記録できる

    fireEvent.click(screen.getByLabelText('した'));
    const method = screen.getByLabelText('手段') as HTMLSelectElement;
    expect(Array.from(method.options).map((o) => o.textContent))
      .toEqual(['手段を選んでください', '電話', 'お迎えのときに対面', '連絡帳・個人チャット', 'その他']);
    expect(record.disabled).toBe(true); // 「した」のときは日時・手段・相手が要る

    // 連絡した日時は発見時刻（初期値はいまの 13:30）より前にできない
    fireEvent.change(screen.getByLabelText('連絡した日時'), { target: { value: `${today()}T13:30` } });
    fireEvent.change(method, { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('相手'), { target: { value: '母（勤務先）' } });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);

    await waitFor(() => expect(db.napAbnormals.some((a) => a.situation === '呼吸の確認に時間がかかった')).toBe(true));
    expect(db.napAbnormals.find((a) => a.situation === '呼吸の確認に時間がかかった')).toMatchObject({
      guardian_notice: '1', guardian_noticed_at: `${today()}T13:30:00`,
      guardian_notice_method: '1', guardian_notice_person: '母（勤務先）',
    });
    // 一覧の「対応」の欄に、保護者への連絡を添える（同じファイルの前のテストの記録も並ぶため、本文で探す）
    // 入力欄の値も textContent に出るため、表の行が出るまで待つ
    const findRow = () => Array.from(document.querySelectorAll('tbody tr'))
      .find((tr) => tr.textContent?.includes('呼吸の確認に時間がかかった'));
    await waitFor(() => expect(findRow()).toBeTruthy());
    const row = findRow()!;
    expect(row.textContent).toContain('保護者への連絡：した（');
    expect(row.textContent).toContain('・電話・母（勤務先））');
    // 記録したあとは、保護者への連絡も未記入に戻る
    expect(screen.queryByLabelText('手段')).toBeNull();
  });
});
