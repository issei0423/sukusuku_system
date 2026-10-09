// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
