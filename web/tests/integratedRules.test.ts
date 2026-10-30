import { expect, it, vi } from 'vitest';
import { api, visibleChildren } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { addDays, formatTemperature, now, today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};

it('園児の選択肢は、サーバと同じよみ順になる', () => {
  const rows = visibleChildren(teacher);
  expect(rows.map((c) => c.child_id)).toEqual([...rows].sort((a, b) =>
    a.child_name_kana.localeCompare(b.child_name_kana, 'ja') || a.child_id.localeCompare(b.child_id)).map((c) => c.child_id));
});

it('保護者と園児の紐づけの日付も、デモの起動日に合わせて動く', () => {
  const offset = (Date.parse(today()) - Date.parse('2026-09-01')) / 86_400_000;
  // デモの鈴木 浩之（C003）の解除は基準日の4日前（紐づけを戻せる期間の内に置いた。mockDb.ts・server/seed.sql）
  expect(db.guardianChildren.find((x) => x.child_id === 'C003')?.ended_at?.slice(0, 10)).toBe(addDays('2026-08-28', offset));
});

it('体温は整数値でも小数第1位を表示する', () => {
  expect(formatTemperature(37)).toBe('37.0');
});

it('異常時の記録は、発見時刻と保存時刻を別に保持する', async () => {
  vi.setSystemTime(new Date(`${today()}T14:00:00+09:00`));
  try {
  const session = db.napSessions.find((s) => s.class_id === 1 && s.session_date === today() && !s.ended_at)!;
  const foundAt = `${today()}T13:40:00`;
  const record = await api.recordAbnormal(teacher, session.nap_session_id, {
    child_id: 'C001', found_at: foundAt, situation: '呼吸を確認できず', response: '再確認した',
  });
  expect(record.found_at).toBe(foundAt);
  expect(record.recorded_at).toBe(now());
  } finally {
    vi.setSystemTime(new Date(`${today()}T18:00:00+09:00`));
  }
});
