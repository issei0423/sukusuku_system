/*
 * 誤送信への対応の記録の「発生日時」（GitHub Issue #178 の 1）
 * 典拠：図/画面詳細図.md「誤送信対応記録画面（管理者）」(4-4) 項目3「発生日時｜初期値：対象メッセージの送信日時／入力：必須」
 *      基本設計書「誤送信への対応」(4-6)
 *
 * 発生日時が空のとき、記録した時刻を黙って入れていた。監査の記録が事実と違う時刻になるため、空は断る。
 * ここで確かめる規則は、Go サーバ（server/api_chat.go の handleAddMisdeliveryRecord）にも同じものがある。
 * server/api_misdelivery_test.go が同じ観点を確かめている。片方だけを直すと食い違う。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: '1' | '2' | '3', email: string, extra: Partial<SessionUser> = {}): SessionUser => ({
  account_id, email, role, display_name: email, staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', 'nohara@hoiku.example.jp', { staff_id: 'S001' });
const teacher = user(3, '2', 'takanashi@hoiku.example.jp', { staff_id: 'S003', class_id: 1 });

describe('誤送信への対応の記録は、発生日時が無いと断る（GitHub Issue #178 の 1）', () => {
  it('空・秒の無い形・実在しない日時は断り、入れた発生日時のまま残す', async () => {
    const sent = await api.send(teacher, 3, '（誤送信）明日の持ち物');
    await api.retract(teacher, sent.chat_message_id);
    const input = (occurred_at: string) => ({
      chat_message_id: sent.chat_message_id, occurred_at, was_read: false, response: '送信者へ取り消しを依頼した',
    });

    await expect(api.addMisdeliveryRecord(admin, input(''))).rejects.toThrow('発生日時を入力してください');
    await expect(api.addMisdeliveryRecord(admin, input('2026-10-17T15:10'))).rejects.toThrow('発生日時の形式が正しくありません');
    await expect(api.addMisdeliveryRecord(admin, input('2026-02-30T15:10:00'))).rejects.toThrow('発生日時の形式が正しくありません');

    await api.addMisdeliveryRecord(admin, input('2026-10-17T15:10:00'));
    const records = db.misdeliveryRecords.filter((r) => r.chat_message_id === sent.chat_message_id);
    expect(records).toHaveLength(1);
    expect(records[0].occurred_at).toBe('2026-10-17T15:10:00');
  });
});
