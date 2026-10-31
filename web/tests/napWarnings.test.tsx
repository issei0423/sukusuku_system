// @vitest-environment jsdom
/*
 * 午睡チェック画面で、うつ伏せ・呼吸「確認できず」を選んだときに出す文
 * 典拠：図/画面詳細図.md「午睡チェック画面」(5-1) の項目10「呼吸」・項目14「注意喚起」（第2.3版。PR #216、未マージ）、
 *      詳細設計書.md「共通」(4-1) の「(6) 本書で足す文言」、利用手引き.md「午睡チェック（最も重要な運用）」(2-5)
 *
 * 呼吸「確認できず」は、記録より先に子どもへの対応と応援の要請を促し、異常時の記録はそのあとでよいと伝える。
 * うつ伏せは注意喚起であって判定ではない。どちらも記録は妨げない。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

const BREATHING_TEXT = '呼吸が確認できません。ただちに、子どもへの対応と応援の要請を行ってください。異常時の記録は、そのあとでかまいません。';
const PRONE_TEXT = 'うつ伏せです。このまま記録し、仰向けに直したら、直したあとの向きをもう一度記録してください。';

// 午睡の時間帯（13:00-15:00）の中に時計を固定する。デモの実施が自動で解除されないようにするため（napDevScreens.test.tsx と同じ）
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${today()}T13:30:00+09:00`));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function firstRow() {
  render(
    <MemoryRouter initialEntries={['/staff/nap']}>
      <SessionProvider initialUser={teacher}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
  await waitFor(() => {
    expect(document.querySelectorAll('.nap-record-row').length).toBeGreaterThan(0);
  }, { timeout: 3000 });
  return document.querySelector<HTMLElement>('.nap-record-row')!;
}

const choose = (row: HTMLElement, field: string, value: string) =>
  fireEvent.click(row.querySelector<HTMLInputElement>(`input[name^="${field}-"][value="${value}"]`)!);

const alertTexts = (row: HTMLElement) => Array.from(row.querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? '');

describe('午睡チェック画面：異常に気づいたときの文', () => {
  it('呼吸「確認できず」を選ぶと、記録より先に子どもへの対応と応援の要請を促し、記録はそのあとでよいと伝える', async () => {
    const row = await firstRow();
    expect(row.textContent).not.toContain('呼吸が確認できません');

    choose(row, 'breathing', '2');
    const text = alertTexts(row).find((t) => t.includes('呼吸が確認できません'));
    expect(text).toContain(BREATHING_TEXT);
    // 対応と応援の要請が先、異常時の記録はあと（記録へ向かわせる文にしない）
    expect(text!.indexOf('子どもへの対応と応援の要請')).toBeLessThan(text!.indexOf('異常時の記録'));
    expect(text).not.toContain('異常時の記録を残してください');

    // 「あり」に選び直すと消える
    choose(row, 'breathing', '1');
    expect(row.textContent).not.toContain('呼吸が確認できません');
  });

  it('うつ伏せを選ぶと、判定の言葉を入れない注意喚起の文を出す。保存の前に「記録します」と言い切らない', async () => {
    const row = await firstRow();
    choose(row, 'position', '2');
    const text = alertTexts(row).find((t) => t.includes('うつ伏せ'));
    expect(text).toContain(PRONE_TEXT);
    // 言い切ると記録が済んだと受け取られ、「記録する」を押さずに離れるおそれがある（PR #223 の自動レビュー）
    expect(text).not.toContain('記録します');

    choose(row, 'position', '1');
    expect(row.textContent).not.toContain(PRONE_TEXT);
  });

  /*
   * 文は選んだ欄（体位・呼吸・顔色）のすぐ後ろ、体温・「記録する」より前に置く。iPad 縦のように段が折れる幅でも、
   * 保存のボタンより先に文が目に入るようにするため（見直し 2026-10-31 の c5-06。#349 で「この子を記録」（いまの「記録する」）の後ろへ移っていた）
   */
  it('うつ伏せ・呼吸の文は、選んだ欄の後ろ、「記録する」より前に出す', async () => {
    const row = await firstRow();
    choose(row, 'position', '2');
    choose(row, 'breathing', '2');
    const alerts = Array.from(row.querySelectorAll('[role="alert"]'));
    expect(alerts).toHaveLength(2);
    const fields = row.querySelector('.nap-inline-fields')!;
    const actions = row.querySelector('.nap-row-actions')!;
    for (const alert of alerts) {
      expect(fields.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(alert.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // 文は選んだ欄と同じ段の並び（.nap-row-body）の中に置く
    expect(alerts.every((a) => a.parentElement?.classList.contains('nap-row-body'))).toBe(true);
  });

  it('どちらの文が出ていても記録は妨げない。記録すると選択が空に戻り、文も消える', async () => {
    const row = await firstRow();
    choose(row, 'position', '2');
    choose(row, 'breathing', '2');
    choose(row, 'complexion', '1');
    expect(row.textContent).toContain(PRONE_TEXT);
    expect(row.textContent).toContain(BREATHING_TEXT);

    const save = row.querySelector<HTMLButtonElement>('.nap-row-actions .btn-primary')!;
    // 表示名は「記録する」、読み上げの名前は「（氏名）を記録する」（図/画面詳細図「午睡チェック画面」(5-1) 項目15。受け入れテスト 04-001・04-007）
    expect(save.textContent).toBe('記録する');
    const name = row.querySelector('.nap-row-head .name')!.textContent;
    expect(save.getAttribute('aria-label')).toBe(`${name}を記録する`);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(row.textContent).toContain('保存しました'));
    expect(row.textContent).not.toContain(PRONE_TEXT);
    expect(row.textContent).not.toContain(BREATHING_TEXT);
  });
});
