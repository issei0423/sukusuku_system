/*
 * 午睡チェックの誤りの文言（モック）
 * 典拠：基本設計書「メッセージ一覧」(4-12) の午睡チェック、詳細設計書「午睡（ねた・おきた・対象外）」(4-6) の共通・(5)。
 * 受け入れテスト 04-019・04-022 の文言。
 *
 * 設計書の文言を、src/messages.ts の MSG を使わずに文字で持つ。定数の書き換えで文言が設計から離れたときにも気づくため。
 * Go の同じ観点は server/api_nap_messages_test.go にある。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const WANT_SESSION_ENDED = '午睡チェックは終了しています。画面を読み込み直してください。';
const WANT_EXCLUDE_AFTER_SLEEP = '「ねた」を記録した園児は対象外にできません。';

const user = (account_id: number, role: SessionUser['role'], extra: Partial<SessionUser>): SessionUser => ({
  account_id, email: `${account_id}@example.jp`, role, display_name: `アカウント${account_id}`,
  staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});

// デモデータの人物（mockDb.ts。server/seed.sql と同じ）
const admin = user(1, '1', { staff_id: 'S001' });
const teacher = user(3, '2', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' }); // さくら組の担任 鈴木

/** さくら組のその日の実施を新しく始める（デモの実施中の午睡は、終えてから始める） */
async function freshSession(): Promise<number> {
  const s = await api.activeSession(1, today(), admin);
  if (s) await api.endSession(admin, s.nap_session_id);
  return (await api.startSession(teacher, 1, today())).nap_session_id;
}

describe('午睡チェックの誤りの文言（基本設計書「メッセージ一覧」(4-12)）', () => {
  it('「ねた」のある子を対象外にしようとしたら、設計書の文を返す', async () => {
    const sessionId = await freshSession();
    await api.sleep(teacher, sessionId, 'C001');
    await expect(api.exclude(teacher, sessionId, 'C001', '1')).rejects.toThrow(WANT_EXCLUDE_AFTER_SLEEP);
    await api.endSession(teacher, sessionId);
  });

  it('終わった実施へ送った5分ごとの確認・異常時の記録・ねたは、どれも同じ設計書の文を返す', async () => {
    const sessionId = await freshSession();
    await api.endSession(teacher, sessionId);
    const check = { child_id: 'C002', body_position: '1', breathing: '1', complexion: '1', temperature: null } as const;
    await expect(api.record(teacher, sessionId, check)).rejects.toThrow(WANT_SESSION_ENDED);
    await expect(api.recordAbnormal(teacher, sessionId, {
      child_id: 'C002', found_at: `${today()}T00:00:00`, situation: '状況', response: '対応',
    })).rejects.toThrow(WANT_SESSION_ENDED);
    await expect(api.sleep(teacher, sessionId, 'C002')).rejects.toThrow(WANT_SESSION_ENDED);
  });
});
