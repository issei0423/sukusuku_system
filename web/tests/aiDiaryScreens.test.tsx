// @vitest-environment jsdom
/*
 * 日誌作成・編集画面の AI の下書き
 * 典拠：詳細設計書「日誌の画面（作り直し）」(2-13 (7))・「保育日誌の下書き」(8-12)・「画面」(8-9)・
 *      「キーが無い・無効・有効にしていないときの画面」(8-8)、基本設計書「文章の下書き（AI）」(4-11)「使いどころと使わないところ」
 *
 * 画面はモック（api/mock.ts）が相手で、外部へはつながない。時計は今日の 18:00。mockDb はこのファイルのテストで使い回す。
 * モックの規則は web/tests/aiDiary.test.ts、Go の規則は server/api_ai_diary_test.go が確かめる。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { clearNotice } from '../src/components/feedback';
import { mockAi, aiDiarySystemFor, AI_SYSTEM } from '../src/api/mock';
import * as db from '../src/api/mockDb';
import { AI_TEXT, MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
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
const setSetting = (key: string, value: string) => { db.settings.find((s) => s.setting_key === key)!.setting_value = value; };

beforeEach(() => {
  setSetting('ai.enabled', '1');
  setSetting('ai.daily_limit', '300');
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false, lastSent: null, calls: 0 });
});
afterEach(() => {
  cleanup();
  act(() => clearNotice());
  setSetting('ai.enabled', '0');
  Object.assign(mockAi, { mode: 'ok', keyPresent: true, keyRejected: false });
});

const bodyArea = () => document.querySelector('textarea[maxlength="2000"]') as HTMLTextAreaElement;
const draftButton = () => screen.queryByRole('button', { name: AI_TEXT.draftButton });
const templateSelect = () => screen.getByLabelText('雛形を呼び出す') as HTMLSelectElement;

/** 日誌作成画面を開き、雛形と定型文が読み込まれるまで待つ */
async function editorReady() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
    expect(templateSelect().options.length).toBeGreaterThan(1);
  }, { timeout: 3000 });
}

/** 担任の西田 太郎（C001）の個人日誌を書き始め、「きょうのようすから」の自動の取り込みが落ち着いたあとの本文を空にする */
async function startPersonalWithEmptyBody() {
  open('/staff/diary/new', teacher);
  await editorReady();
  fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C001' } });
  await new Promise((r) => setTimeout(r, 200));
  fireEvent.change(bodyArea(), { target: { value: '' } });
}
const pickTemplate = (name: string) => {
  const t = Array.from(templateSelect().options).find((o) => o.textContent === name)!;
  fireEvent.change(templateSelect(), { target: { value: t.value } });
};

describe('日誌作成・編集画面：AI の下書き', () => {
  it('園が有効にしていない・キーが無いときはボタンを出さず、ほかはそのまま使える', async () => {
    setSetting('ai.enabled', '0');
    await startPersonalWithEmptyBody();
    await new Promise((r) => setTimeout(r, 150));
    expect(draftButton()).toBeNull();
    fireEvent.change(bodyArea(), { target: { value: '園庭で遊びました。' } });
    expect(bodyArea().value).toBe('園庭で遊びました。');
    cleanup();

    setSetting('ai.enabled', '1');
    mockAi.keyPresent = false;
    await startPersonalWithEmptyBody();
    await new Promise((r) => setTimeout(r, 150));
    expect(draftButton()).toBeNull();
    expect(mockAi.calls).toBe(0);
  });

  it('本文が見出しの行だけなら、下書きをそのまま入れる。保護者に届かない日誌なので「保存してから」の注意を添え、言い換え・続きは出さない', async () => {
    await startPersonalWithEmptyBody();
    pickTemplate('個人日誌（標準）');
    expect(bodyArea().value).toContain('【今日の様子】');
    fireEvent.click(await screen.findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 }));
    expect(screen.getByText(AI_TEXT.memoNote)).toBeTruthy();
    expect(screen.queryByRole('button', { name: AI_TEXT.rephraseButton })).toBeNull();
    expect(screen.queryByRole('button', { name: AI_TEXT.continueButton })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^メモ/), { target: { value: '美咲ちゃんとしゃぼん玉を追いかけた' } });
    fireEvent.click(screen.getByRole('button', { name: AI_TEXT.makeDraft }));
    await waitFor(() => expect(bodyArea().value).toContain('おともだちとしゃぼん玉を追いかけた'), { timeout: 3000 });
    // 送った見出し（本文の【…】の行）が、返った見出しとして本文に入っている。先頭の見出しにだけ材料が入る
    expect(JSON.parse(mockAi.lastSent!.user).見出し).toEqual(['今日の様子', '食事', '排泄', '午睡', '気づいたこと']);
    expect(bodyArea().value).toContain('おともだちとしゃぼん玉を追いかけた');
    for (const h of ['【食事】', '【排泄】', '【午睡】', '【気づいたこと】']) expect(bodyArea().value).toContain(h);
    expect(screen.getByText(AI_TEXT.checkBeforeSave)).toBeTruthy();
    expect(screen.queryByText(AI_TEXT.checkBeforeSend)).toBeNull();
    expect(screen.getByText(AI_TEXT.replacedOthers)).toBeTruthy();
    expect(mockAi.lastSent!.system).toBe(AI_SYSTEM.diary);
    // 勝手には保存・申請しない（下書き保存のボタンは職員が押す）
    expect(db.diaries.some((d) => d.body.includes('おともだちとしゃぼん玉を追いかけた'))).toBe(false);
  });

  it('本文が空なら【記録】1つと下書きが入る', async () => {
    await startPersonalWithEmptyBody();
    fireEvent.click(await screen.findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 }));
    fireEvent.click(screen.getByRole('button', { name: AI_TEXT.makeDraft }));
    await waitFor(() => expect(bodyArea().value).toMatch(/^【記録】/), { timeout: 3000 });
    expect(JSON.parse(mockAi.lastSent!.user).見出し).toEqual(['記録']);
  });

  it('本文に文があれば置き換えずに候補として出し、「この文を使う」で入れ替える', async () => {
    await startPersonalWithEmptyBody();
    fireEvent.change(bodyArea(), { target: { value: '【今日の様子】\n園庭で遊びました。' } });
    fireEvent.click(await screen.findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 }));
    fireEvent.change(screen.getByLabelText(/^メモ/), { target: { value: 'しゃぼん玉をした' } });
    fireEvent.click(screen.getByRole('button', { name: AI_TEXT.makeDraft }));
    const use = await screen.findByRole('button', { name: AI_TEXT.useThis }, { timeout: 3000 });
    // 置き換えずに、本文はそのまま
    expect(bodyArea().value).toBe('【今日の様子】\n園庭で遊びました。');
    expect(JSON.parse(mockAi.lastSent!.user).見出し).toEqual(['今日の様子']);
    const card = use.closest('li') as HTMLElement;
    expect(within(card).getByText(/しゃぼん玉をした/)).toBeTruthy();
    fireEvent.click(use);
    await waitFor(() => expect(bodyArea().value).toMatch(/^【今日の様子】\n[\s\S]*しゃぼん玉をした/));
    expect(bodyArea().value).not.toContain('園庭で遊びました。');
  });

  it('保護者へ共有する個人日誌では、保護者へ送る文の決まりと「送ってから」の注意になる', async () => {
    await startPersonalWithEmptyBody();
    fireEvent.click(screen.getByRole('checkbox', { name: /保護者へ共有する/ }));
    fireEvent.click(await screen.findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 }));
    fireEvent.click(screen.getByRole('button', { name: AI_TEXT.makeDraft }));
    await waitFor(() => expect(screen.getByText(AI_TEXT.checkBeforeSend)).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByText(AI_TEXT.checkBeforeSave)).toBeNull();
    expect(mockAi.lastSent!.system).toBe(aiDiarySystemFor(true));
  });

  it('失敗したら応答の文を出し、本文は残す', async () => {
    await startPersonalWithEmptyBody();
    fireEvent.change(bodyArea(), { target: { value: '園庭で遊びました。' } });
    mockAi.mode = 'fail';
    fireEvent.click(await screen.findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 }));
    fireEvent.click(screen.getByRole('button', { name: AI_TEXT.makeDraft }));
    expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toBe(MSG.aiFailed);
    expect(bodyArea().value).toBe('園庭で遊びました。');
  });

  it('ヒヤリハットには置かない。保護者がまだ同意していない子・クラス日誌（さくら組は全員が条件を満たさない）にも出ない', async () => {
    open('/staff/diary/new', teacher);
    await editorReady();
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C001' } });
    await screen.findByRole('button', { name: AI_TEXT.draftButton }, { timeout: 3000 });
    fireEvent.click(screen.getByLabelText('ヒヤリハット'));
    await waitFor(() => expect(draftButton()).toBeNull());
    fireEvent.click(screen.getByLabelText('クラス日誌'));
    await new Promise((r) => setTimeout(r, 150));
    expect(draftButton()).toBeNull();
    fireEvent.click(screen.getByLabelText('個人日誌'));
    fireEvent.change(screen.getByLabelText('対象の園児'), { target: { value: 'C002' } });
    await new Promise((r) => setTimeout(r, 150));
    expect(draftButton()).toBeNull();
  });
});
