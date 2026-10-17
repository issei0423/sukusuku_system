// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = { account_id: 1, email: '', role: '1', display_name: '管理者', staff_id: 'S001', guardian_id: null,
  class_id: null, class_name: null, is_temp_password: false, terms_agreed: true };
const teacher: SessionUser = { ...admin, account_id: 5, role: '2', staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' };
const other: SessionUser = { ...admin, account_id: 3, role: '2', staff_id: 'S003', class_id: 1, class_name: 'さくら組' };
const open = (user: SessionUser, roomID: number) => render(<MemoryRouter initialEntries={[`/staff/chat?room=${roomID}`]}>
  <SessionProvider initialUser={user}><App /></SessionProvider>
</MemoryRouter>);
afterEach(cleanup);

it('保護者未登録の園児の個人チャットを担任が画面から開いて書け、別クラスには表示しない', async () => {
  await api.saveChild(admin, { child_id: 'C951', child_name: '試験 花', child_name_kana: 'しけん はな',
    birth_date: '2025-01-01', sex: '2', normal_temperature: null, photo_consent_level: '2',
    class_id: 2, allergies: [], medical_histories: [] }, 'create');
  const roomID = db.chatRooms.find((r) => r.child_id === 'C951')!.chat_room_id;
  const view = open(teacher, roomID);
  expect(await screen.findByText('まだ保護者が登録していません（登録すると読めます）')).toBeTruthy();
  expect(document.querySelector('.channel.current')?.textContent).toContain('試験 花の園とのやりとり');
  fireEvent.change(screen.getByPlaceholderText('メッセージを入力'), { target: { value: '園からの連絡' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await waitFor(() => expect(db.chatMessages.some((m) => m.chat_room_id === roomID && m.body === '園からの連絡')).toBe(true));
  view.unmount();
  open(other, roomID);
  await screen.findByRole('heading', { name: 'チャット' });
  expect(screen.queryByText('試験 花の園とのやりとり')).toBeNull();
});
