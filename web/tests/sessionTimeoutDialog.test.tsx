// @vitest-environment jsdom
/*
 * 自動ログアウトの予告と「続ける」の画面（GitHub Issue #210。2026-10-19 に持ち主が任せて決めた範囲）
 * 典拠：基本設計書.md「ログイン」(4-3)「自動ログアウトは職員の画面に限り、最後の操作から時間を数える。
 *      午睡チェックの実施中は対象外」、WCAG 2.2 達成基準 2.2.1 タイミング調整可能（レベル A）
 *
 * 職員の画面に、切れる2分前【仮置き】に role="alertdialog" の窓で「まもなくログアウトします」と「続ける」を出す。
 * 開いたら「続ける」にフォーカスし、押したら期限を延ばして閉じ、前にいた部品へフォーカスを戻す。
 * 期限は相手（モック。api/mock.ts の sessionStatus）が決めたものを尋ね直して使う。ほかのタブで操作・延長していれば
 * 古い予告を出さず、出していれば閉じる。午睡チェックの実施中と、保護者の画面には出さない。
 *
 * 時計とタイマー（Date・setTimeout）を偽物にし、vi.advanceTimersByTimeAsync で進める。
 * モックの応答（setTimeout 60ミリ秒）も、進めた時間のぶんだけ返る。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import SessionTimeoutWarning from '../src/components/SessionTimeoutWarning';
import { api, onSessionEnded } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const MINUTE = 60_000;
const at = (hm: string) => new Date(`${today()}T${hm}:00+09:00`);

/** 時間を進める。部品のタイマーと、モックの応答の両方が、進めた時間のぶんだけ動く */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** モックへ呼び出しを送り、応答を待つ（モックの応答は setTimeout で返る） */
async function settle<T>(p: Promise<T>): Promise<T> {
  await advance(100);
  return p;
}

/** 書きかけの日誌を開いている職員の画面に見立てる。予告の部品は職員の共通レイアウトと同じく1つ置く */
function renderPage(user: SessionUser) {
  render(
    <SessionProvider initialUser={user}>
      <main tabIndex={-1}>
        <label>きょうの日誌<textarea /></label>
      </main>
      <SessionTimeoutWarning />
    </SessionProvider>,
  );
  const draft = screen.getByLabelText('きょうの日誌');
  draft.focus();
  return draft;
}

const dialog = () => screen.queryByRole('alertdialog');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: at('18:00') });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('切れる2分前の予告と「続ける」', () => {
  it('2分前に alertdialog で予告し、開いたら「続ける」にフォーカスする', async () => {
    await settle(api.login(teacher.email, 'pass1234', 'staff'));
    renderPage(teacher);

    await advance(28 * MINUTE - 2_000);
    expect(dialog()).toBeNull();

    await advance(3_000);
    const d = screen.getByRole('alertdialog', { name: 'まもなくログアウトします' });
    expect(d.getAttribute('aria-modal')).toBe('true');
    // 切れる時刻はモック（相手）が返した時刻。ログインの 18:00 から30分
    expect(d.textContent).toContain('18:30 ごろに自動でログアウトします');
    const button = screen.getByRole('button', { name: '続ける' });
    expect(document.activeElement).toBe(button);

    // 押せるのは「続ける」だけ。Tab で窓の外へ出さない
    expect(fireEvent.keyDown(button, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('「続ける」で期限を延ばして閉じ、前にいた部品へフォーカスを戻す', async () => {
    await settle(api.login(teacher.email, 'pass1234', 'staff'));
    const draft = renderPage(teacher);
    await advance(28 * MINUTE + 1_000);
    expect(dialog()).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '続ける' }));
    await advance(100);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(draft);

    // 押した時刻（18:28:01）から30分に延びた。18:30 を過ぎても出ず、延びた期限の2分前にまた出る
    expect((await settle(api.sessionStatus(teacher))).expires_at).toBe(`${today()}T18:58:01`);
    await advance(26 * MINUTE);
    expect(dialog()).toBeNull();
    await advance(3 * MINUTE);
    expect(screen.getByRole('alertdialog').textContent).toContain('18:58 ごろ');
  });

  it('Esc も「続ける」と同じにする（閉じるだけにして、予告が消えたまま切れることはしない）', async () => {
    await settle(api.login(teacher.email, 'pass1234', 'staff'));
    const draft = renderPage(teacher);
    await advance(28 * MINUTE + 1_000);

    fireEvent.keyDown(screen.getByRole('button', { name: '続ける' }), { key: 'Escape' });
    await advance(100);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(draft);
    expect((await settle(api.sessionStatus(teacher))).expires_at).toBe(`${today()}T18:58:01`);
  });

  it('切れる時刻を過ぎたら、尋ねた応答で切れたことを受け取る（入口へ戻すのは App.tsx）', async () => {
    await settle(api.login(teacher.email, 'pass1234', 'staff'));
    renderPage(teacher);
    await advance(28 * MINUTE + 1_000);
    expect(dialog()).not.toBeNull();

    let ended = 0;
    const stop = onSessionEnded(() => { ended += 1; });
    try {
      await advance(MINUTE + 57_000);
      expect(ended).toBe(0);
      await advance(5_000);
      expect(ended).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});

describe('ほかのタブ', () => {
  it('ほかのタブで操作していれば、予告を出さない（尋ね直した期限で決める）', async () => {
    await settle(api.login(teacher.email, 'pass1234', 'staff'));
    renderPage(teacher);

    // 18:20 にほかのタブで操作した。同じセッションなので期限は 18:50 に延びている
    await advance(20 * MINUTE);
    await settle(api.listChildren(teacher));
    await advance(9 * MINUTE);
    expect(dialog()).toBeNull();

    // 延びた期限の2分前（18:48）には出す
    await advance(19 * MINUTE + 2_000);
    expect(screen.getByRole('alertdialog').textContent).toContain('18:50 ごろ');
  });

  it('予告を出している間に、ほかのタブで延ばしたら閉じて、前にいた部品へフォーカスを戻す', async () => {
    await settle(api.login(teacher.email, 'pass1234', 'staff'));
    const draft = renderPage(teacher);
    await advance(28 * MINUTE + 1_000);
    expect(dialog()).not.toBeNull();

    await settle(api.extendSession(teacher));
    await advance(5_000);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(draft);
  });
});

describe('出さないとき', () => {
  it('開始した午睡チェックの実施中は出さない。時間帯の終わりから数え直して、その2分前に出す', async () => {
    vi.setSystemTime(at('13:30'));
    // 高梨（S003）が 13:05 にさくら組の午睡チェックを開始し、終えていない
    const nap = {
      nap_session_id: 90_002, class_id: 1, session_date: today(), started_staff_id: 'S003',
      started_at: `${today()}T13:05:00`, ended_staff_id: null, ended_at: null, is_auto_closed: false,
    };
    db.napSessions.push(nap);
    try {
      await settle(api.login(teacher.email, 'pass1234', 'staff'));
      renderPage(teacher);

      // ログインから30分を過ぎても、実施中は出さない（14:30）
      await advance(60 * MINUTE);
      expect(dialog()).toBeNull();

      // 午睡の時間帯（13:00-15:00）の終わりで解除し、15:00 から30分。15:27 にはまだ出さず、15:28 に出す
      await advance(57 * MINUTE);
      expect(dialog()).toBeNull();
      await advance(2 * MINUTE);
      expect(screen.getByRole('alertdialog').textContent).toContain('15:30 ごろ');
    } finally {
      db.napSessions.splice(db.napSessions.indexOf(nap), 1);
    }
  });

  it('保護者には自動ログアウトが無いので出さない', async () => {
    await settle(api.login(guardian.email, 'pass1234', 'guardian'));
    renderPage(guardian);
    await advance(40 * MINUTE);
    expect(dialog()).toBeNull();
  });
});

describe('置き場所', () => {
  function openApp(path: string, user: SessionUser) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider initialUser={user}>
          <App />
        </SessionProvider>
      </MemoryRouter>,
    );
  }

  it('職員の共通レイアウトに置いてある', async () => {
    await settle(api.login(teacher.email, 'pass1234', 'staff'));
    openApp('/staff', teacher);
    await advance(28 * MINUTE + 1_000);
    expect(screen.getByRole('alertdialog', { name: 'まもなくログアウトします' })).toBeTruthy();
  });

  it('保護者の共通レイアウトには置かない', async () => {
    await settle(api.login(guardian.email, 'pass1234', 'guardian'));
    openApp('/guardian', guardian);
    await advance(40 * MINUTE);
    expect(dialog()).toBeNull();
  });
});
