// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Alert, Field, Modal, Radios } from '../src/components/ui';

afterEach(cleanup);

describe('共通部品の読み上げとキーボード操作', () => {
  it('入力欄の見出しを名前にし、見出しを押すと欄へ移る', () => {
    render(<Field label="ログインID" required><input type="email" /></Field>);
    const input = screen.getByRole('textbox', { name: 'ログインID' });
    expect(input.getAttribute('aria-required')).toBe('true');
    expect((screen.getByText('ログインID') as HTMLLabelElement).htmlFor).toBe(input.id);
  });

  it('選択肢の組に名前があり、エラーが通知として伝わる', () => {
    render(<><Field label="体位" required>
      <Radios name="position" value={null} options={[{ value: 'back', label: '仰向け' }]} onChange={() => {}} />
    </Field><Alert>保存できませんでした</Alert></>);
    expect(screen.getByRole('radiogroup', { name: '体位' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('保存できませんでした');
  });

  it('モーダルを開くと中へ移り、Tab は中に留まり、Esc で元のボタンへ戻る', () => {
    const onClose = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>開く</button>{open &&
        <Modal title="確認" onClose={() => { onClose(); setOpen(false); }}
          footer={<><button>戻る</button><button>進む</button></>}>
          <input aria-label="理由" />
        </Modal>}</>;
    }
    render(<Example />);
    const opener = screen.getByRole('button', { name: '開く' });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole('textbox', { name: '理由' });
    expect(document.activeElement).toBe(input);
    const last = screen.getByRole('button', { name: '進む' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  /*
   * 押すとすぐ取り返しにくい記録をする窓は、開いたときにいちばん弱い操作（「やめる」）へ入れる
   * （WAI-ARIA Authoring Practices「Dialog (Modal) Pattern」。午睡チェックの「対象外」の窓、PR #226）。
   * 窓の中の部品に data-initial-focus を付けると、入力欄や先頭の部品より先にそこへ入る
   */
  it('モーダルの中に data-initial-focus の部品があれば、開いたときに入力欄や先頭の部品より先にそこへ入る', () => {
    render(<Modal title="対象外にする" onClose={() => {}}
      footer={<button type="button" data-initial-focus>やめる</button>}>
      <input aria-label="メモ" />
      <button type="button">欠席</button>
    </Modal>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'やめる' }));
  });

  it('data-initial-focus の部品が押せないときは、ふだんの順（入力欄、無ければ先頭の部品）で入る', () => {
    render(<Modal title="対象外にする" onClose={() => {}}
      footer={<button type="button" data-initial-focus disabled>やめる</button>}>
      <button type="button">欠席</button>
    </Modal>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '欠席' }));
  });
});

describe('押せるものどうしの間は 8px 以上（詳細設計書「全画面に共通する部品と決まり」(2-0 (4)) の「タッチの条件」、GitHub Issue #215）', () => {
  // jsdom は画面の CSS を読まず並べ方を測れないため、規則の文で見る（画面で測るのは tests/responsive/a11y-keyboard-contact.spec.ts の touchProblems）
  const screensCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/screens.css'), 'utf8');
  const gapOf = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return screensCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\bgap:\\s*([^;]+);`))?.[1].trim() ?? null;
  };

  it.each([
    ['.growth-switch', '成長の記録の「身長」「体重」'],
    ['.ai-draft-memo', 'AI の下書きのメモの欄と「下書きを作る」'],
    ['.reactions', 'チャットのリアクションどうし'],
    ['.msg-menu-row', 'チャットの操作の一覧のボタンどうし'],
  ])('%s（%s）の間は var(--sp-2)', (selector) => {
    expect(gapOf(selector)).toBe('var(--sp-2)');
  });
});
