// @vitest-environment jsdom
/*
 * 園児の CSV 一括登録（GitHub Issue #160）
 * 典拠：基本設計書.md「CSV一括登録」(4-4)「平熱が数値でない行は誤りとする。範囲の外の平熱は誤りとせず、
 *      確認を促す表示を添える」、「入力項目の制約値」(4-9)「平熱｜30.0〜43.0℃、小数第1位まで」
 *      「園児ID・職員ID｜20文字以内」、図/画面詳細図.md 7-3「検証と登録を2段階に分ける」
 *
 * Go サーバ側（server/api_bulk_test.go）と同じ観点を、モック（api/mock.ts の parseChildCsv）に対して確かめる。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as client from '../src/api/client';
import { api } from '../src/api/client';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

const head = '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱\n';
const rowWith = (temp: string) => `${head}C501,平熱 一,へいねつ いち,2025-04-01,1,さくら組,${temp}`;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('平熱は小数第1位までの数に限る（GitHub Issue #160 の 1）', () => {
  it('数として書かれていない平熱は誤りにする', () => {
    for (const v of ['inf', 'Inf', 'Infinity', '-Infinity', 'NaN', '0x24', '1e2', '-36.5', '+36.5', '３６．５', '36.55']) {
      const { rows } = api.parseChildCsv(rowWith(v));
      expect(rows[0].error, v).toContain('平熱');
    }
  });

  it('小数第1位までの数は通す。範囲の外は誤りにせず、確認を促す', () => {
    for (const [v, warn] of [['36.5', false], ['36', false], ['45.0', true], ['29.9', true], ['365', true]] as const) {
      const { rows } = api.parseChildCsv(rowWith(v));
      expect(rows[0].error, v).toBeNull();
      expect(!!rows[0].warning, v).toBe(warn);
    }
  });
});

describe('生年月日・園児ID・見出し（GitHub Issue #160 の 2）', () => {
  it('存在しない生年月日は誤りにする', () => {
    for (const d of ['2025-02-30', '2025-13-45', '2025-00-10', '2024-02-30']) {
      const { rows } = api.parseChildCsv(`${head}C201,日付 一,ひづけ いち,${d},1,さくら組,36.5`);
      expect(rows[0].error, d).toContain('生年月日');
    }
    expect(api.parseChildCsv(`${head}C201,日付 一,ひづけ いち,2024-02-29,1,さくら組,36.5`).rows[0].error).toBeNull();
  });

  it('園児ID は 20 文字まで', () => {
    expect(api.parseChildCsv(`${head}${'C'.repeat(21)},長い 一,ながい いち,2025-04-01,1,さくら組,36.5`).rows[0].error)
      .toContain('20文字');
    expect(api.parseChildCsv(`${head}${'C'.repeat(20)},長い 一,ながい いち,2025-04-01,1,さくら組,36.5`).rows[0].error)
      .toBeNull();
  });

  it('見出しの並びが違うファイルは、行を読まずに断る。BOM 付き・平熱の列の無い見出しは読む', () => {
    expect(() => api.parseChildCsv('氏名,園児ID,氏名かな,生年月日,性別,クラス名,平熱\n並び 一,C711,ならび いち,2025-04-01,1,さくら組,36.5'))
      .toThrow('見出し');
    const { rows } = api.parseChildCsv('﻿園児ID,氏名,氏名かな,生年月日,性別,クラス名\nC301,見出 一,みだし いち,2025-04-01,1,さくら組');
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBeNull();
  });
});

describe('確認した内容を登録する（GitHub Issue #160 の 3）', () => {
  function open() {
    return render(
      <MemoryRouter initialEntries={['/staff/children/csv']}>
        <SessionProvider initialUser={admin}><App /></SessionProvider>
      </MemoryRouter>,
    );
  }
  const one = `${head}C401,確認 一郎,かくにん いちろう,2025-04-01,1,さくら組,36.5`;
  const three = `${one}\nC402,確認 二郎,かくにん じろう,2025-04-01,1,さくら組,36.5\nC403,確認 三郎,かくにん さぶろう,2025-04-01,1,さくら組,36.5`;

  it('確認したあとに貼り付けの欄を書き換えたら、確認し直すまで登録させない', async () => {
    open();
    const area = await screen.findByLabelText('または内容を貼り付ける');
    fireEvent.change(area, { target: { value: one } });
    fireEvent.click(screen.getByRole('button', { name: '取込内容を確認する' }));
    expect(await screen.findByRole('button', { name: '1 件を登録する' })).toBeTruthy();

    fireEvent.change(area, { target: { value: three } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /件を登録する/ })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '取込内容を確認する' }));
    expect(await screen.findByRole('button', { name: '3 件を登録する' })).toBeTruthy();
  });

  it('登録には、確認したときの内容を送る', async () => {
    const spy = vi.spyOn(client.api, 'importChildCsv').mockResolvedValue(1);
    open();
    const area = await screen.findByLabelText('または内容を貼り付ける');
    fireEvent.change(area, { target: { value: one } });
    fireEvent.click(screen.getByRole('button', { name: '取込内容を確認する' }));
    fireEvent.click(await screen.findByRole('button', { name: '1 件を登録する' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [, rows, text] = spy.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(text).toBe(one);
  });
});
