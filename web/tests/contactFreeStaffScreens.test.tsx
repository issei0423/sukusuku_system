// @vitest-environment jsdom
/*
 * フリー（今年度の担任クラスが無い一般）の職員が、退園・卒園した園児の連絡帳（園児）画面を開いたとき
 * 典拠：詳細設計書「判定の関数」(4-1 (2)) 第1.12版（フリーの Read は在籍中で取り消していない園児。
 *      「権限の外も、園児が無いのも、同じ 403 と同じ文言」）
 *
 * 規則は web/tests/contact.test.ts（モック）と server/api_contact_test.go（Go サーバ）が確かめる。
 * ここでは、画面の出し方が、無い園児を開いたときと同じ（同じ文。新しい文は作らない）ことを確かめる。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

// ひまわり組の担任（S005）を、担任の割り当てを外してフリーにして使う
const free: SessionUser = {
  account_id: 5, email: 'kubota@hoiku.example.jp', role: '2', display_name: '久保田 和也',
  staff_id: 'S005', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={free}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** 開いた画面の、拒んだ文の箱（ErrorBox）の中身 */
async function refusal(path: string): Promise<string> {
  open(path);
  const box = await screen.findByText(MSG.contactForbidden, undefined, { timeout: 3000 });
  const html = box.outerHTML;
  cleanup();
  return html;
}

afterEach(cleanup);

describe('フリーの職員が、退園・卒園した園児の連絡帳を開いたとき', () => {
  it('無い園児を開いたときと同じ文を、同じ形で出す', async () => {
    const child = db.children.find((c) => c.child_id === 'C013')!;
    const staff = db.classStaff.splice(db.classStaff.findIndex((s) => s.staff_id === 'S005'), 1);
    try {
      child.enrollment_status = '3';
      const graduated = await refusal('/staff/contact/C013');
      child.enrollment_status = '2';
      const withdrawn = await refusal('/staff/contact/C013');
      const missing = await refusal('/staff/contact/C999');
      expect(graduated).toBe(missing);
      expect(withdrawn).toBe(missing);
    } finally {
      child.enrollment_status = '1';
      db.classStaff.push(...staff);
    }
  });
});
