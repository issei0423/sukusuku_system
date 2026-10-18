// @vitest-environment jsdom
/*
 * 誤送信対応記録画面の案内（PR #216 の直-23）
 * 典拠：図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目5・項目8、
 *      要件定義書.md「チャットツール」(4-4) の誤送信の扱い（園の運用「情報が含まれていた園児の家庭への連絡」）
 *
 * 設計の直しは PR #216（design-v3-review-1018。未マージ）による。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
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
