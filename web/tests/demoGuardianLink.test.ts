/*
 * デモの鈴木 浩之（G003・アカウント8）は、誤って解除した例（紐づけを戻すの見本）。操作ログは、いまの解除が残す形と同じ2行：
 * 管理者の解除の行（t_guardian_child・有効→終了）と、有効な紐づけがゼロになったことによるシステムの停止の行（照合 c5-08）。
 * 保護者のアカウントを管理者が手で止める操作は無いので、その形の行も置かない（基本設計書「アカウントの停止と再開」(4-3)）。
 *
 * Go サーバ（server/api_guardian_link_test.go の TestDemoUnlinkLogMatchesEndGuardianLink）にも同じ確かめがある。
 * デモデータは server/seed.sql と web/src/api/mockDb.ts の2か所にある。片方だけを直すと食い違う
 */
import { describe, it, expect } from 'vitest';
import * as db from '../src/api/mockDb';

describe('デモの鈴木 浩之の解除の操作ログ（照合 c5-08）', () => {
  it('管理者の解除の行と、システムの停止の行の2行で、解除した日時と同じ', () => {
    const link = db.guardianChildren.find((g) => g.guardian_id === 'G003' && g.child_id === 'C003')!;
    const rows = db.operationLogs.filter((l) => l.target_id === 8 && l.target_child_id === 'C003');
    const end = rows.find((l) => l.target_table === 't_guardian_child');
    const stop = rows.find((l) => l.target_table === 'm_account');
    expect(end).toMatchObject({ account_id: 1, before_value: '有効', after_value: '終了', operated_at: link.ended_at });
    expect(end?.operator_type ?? '1').toBe('1');
    expect(stop).toMatchObject({
      account_id: null, operator_type: '2', before_value: '有効', after_value: '停止（有効な紐づけがゼロになったため）',
      operated_at: link.ended_at,
    });
    // 管理者が鈴木 浩之のアカウントを止めた行は無い
    expect(db.operationLogs.filter((l) => l.target_table === 'm_account' && l.target_id === 8 && (l.operator_type ?? '1') === '1'))
      .toEqual([]);
  });
});
