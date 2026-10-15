// 開発サーバ専用。製品の entry point には読み込まれない。
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '../../src/App';
import { SessionProvider } from '../../src/session';
import { api, backend } from '../../src/api/client';
import type { SessionUser } from '../../src/api/types';
import { scenarios } from './scenarios';
import '../../src/styles/tokens.css';
import '../../src/styles/app.css';
import '../../src/styles/screens.css';

if (!import.meta.env.DEV || backend !== 'mock') throw new Error('レビューは dev + mock 専用です');
const scenario = scenarios.find((s) => s.id === new URLSearchParams(location.search).get('scene'));
if (!scenario) throw new Error('不明なレビューシナリオです');

const users: Record<'teacher' | 'admin' | 'guardian', SessionUser> = {
  teacher: { account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗', staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組', is_temp_password: false, terms_agreed: true },
  admin: { account_id: 1, email: 'nohara@hoiku.example.jp', role: '1', display_name: '野原 一誠', staff_id: 'S001', guardian_id: null, class_id: null, class_name: null, is_temp_password: false, terms_agreed: true },
  guardian: { account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠', staff_id: null, guardian_id: 'G001', class_id: null, class_name: null, is_temp_password: false, terms_agreed: true },
};

// API の連鎖読み込みが静まってから撮影する。固定秒数の待ちや networkidle に依存しない。
let pending = 0;
let quietTimer: number;
function markBusy() {
  document.documentElement.dataset.reviewReady = 'false';
  window.clearTimeout(quietTimer);
}
function settle() {
  if (pending === 0) quietTimer = window.setTimeout(() => {
    document.documentElement.dataset.reviewReady = 'true';
  }, 150);
}
for (const [key, method] of Object.entries(api)) {
  if (typeof method !== 'function') continue;
  Reflect.set(api, key, (...args: unknown[]) => {
    const result: unknown = Reflect.apply(method, api, args);
    if (!(result instanceof Promise)) return result;
    pending += 1;
    markBusy();
    return result.finally(() => { pending -= 1; settle(); });
  });
}
function ReviewLocation() {
  const route = useLocation();
  useEffect(() => {
    document.documentElement.dataset.reviewRoute = route.pathname;
    markBusy();
    settle();
  }, [route.pathname]);
  return null;
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[{ pathname: scenario.path, state: scenario.state }]}>
    <SessionProvider initialUser={scenario.role === 'public' ? null : users[scenario.role]}>
      <ReviewLocation /><App />
    </SessionProvider>
  </MemoryRouter>,
);
