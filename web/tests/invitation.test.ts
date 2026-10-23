/*
 * 招待コードと紐づけのテスト
 * 典拠：要件定義書「招待コードの発行」(4-1-2)、基本設計書 5-2・5-3
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';
import { today } from '../src/api/util';
import { MSG } from '../src/messages';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

describe('招待コード', () => {
  // 文言は基本設計書「メッセージ一覧」(4-12) の招待コードの4つ（tests/invitationMessages.test.ts）
  it('使用済みのコードは確認できない', async () => {
    await expect(api.verifyInvitationCode('IJKL-5678-MNOP')).rejects.toThrow(MSG.invitationUsed);
  });

  it('失効したコードは確認できない', async () => {
    await expect(api.verifyInvitationCode('YZAB-3456-CDEF')).rejects.toThrow(MSG.invitationRevoked);
  });

  it('未使用のコードは確認できる（園児名は返さない）', async () => {
    const r = await api.verifyInvitationCode('ABCD-1234-EFGH');
    expect(r).toEqual({ ok: true });
    // 誰の保護者かを名乗る前の段階のため、園児名を含めない（画面詳細図 2-3）
    expect(JSON.stringify(r)).not.toContain('西田');
  });

  it('大文字小文字を問わず照合する', async () => {
    await expect(api.verifyInvitationCode('abcd-1234-efgh')).resolves.toEqual({ ok: true });
  });

  it('1枚のコードは1アカウントの登録にのみ使える', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C005', 30);
    await api.signUpGuardian({
      code, email: 'test.parent1@example.jp', password: 'kubota-pass-5678',
      guardian_name: '久保田 一郎', relationship: '父', terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
    });
    // 使用と同時に status を使用済みにする
    expect(db.invitationCodes.find((c) => c.code === code)?.status).toBe('2');

    // 使ったコードでの2つ目の登録は、使用済みの文で断る（新規登録の送信も確認と同じ4つの文言。決めたこと D-52）
    await expect(api.signUpGuardian({
      code, email: 'test.parent2@example.jp', password: 'kubota-pass-5678',
      guardian_name: '久保田 花子', relationship: '母', terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
    })).rejects.toThrow(MSG.invitationUsed);
  });

  it('一括発行は 園児数 × 枚数 を発行する', async () => {
    const before = db.invitationCodes.length;
    const children = await api.listChildren(admin, { classId: 2 });
    const r = await api.issueInvitationCodes(admin, 2, 2, 30);
    expect(r.issued).toBe(children.length * 2);
    expect(r.skipped).toBe(0);
    expect(db.invitationCodes.length).toBe(before + r.issued);
  });

  it('一括発行は、使えるコードをすでに持つ園児を飛ばす（指定すれば重ねて発行する）', async () => {
    // 直前のテストで、クラス2の全員が使えるコードを持っている
    const children = await api.listChildren(admin, { classId: 2 });
    const before = db.invitationCodes.length;

    const skippedAll = await api.issueInvitationCodes(admin, 2, 2, 30);
    expect(skippedAll).toEqual({ issued: 0, skipped: children.length });
    expect(db.invitationCodes.length).toBe(before);

    const again = await api.issueInvitationCodes(admin, 2, 1, 30, true);
    expect(again).toEqual({ issued: children.length, skipped: 0 });
  });

  it('登録したメールアドレスは重複させない（ロールをまたいで園内で一意）', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C006', 30);
    await expect(api.signUpGuardian({
      code, email: 'suzuki@hoiku.example.jp', password: 'kubota-pass-5678',
      guardian_name: '重複 太郎', relationship: '父', terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
    })).rejects.toThrow('すでに登録されています');
  });
});

describe('保護者の紐づけ', () => {
  it('有効な紐づけがゼロになった時点でアカウントを停止する', async () => {
    const code = await api.issueOneInvitationCode(admin, 'C007', 30);
    const u = await api.signUpGuardian({
      code, email: 'test.parent3@example.jp', password: 'kubota-pass-5678',
      guardian_name: '中村 二郎', relationship: '父', terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
    });
    expect(u.guardian_id).toBeTruthy();

    await api.endGuardianLink(admin, u.guardian_id!, 'C007');
    const account = db.accounts.find((a) => a.account_id === u.account_id);
    expect(account?.status).toBe('2');
  });
});

describe('身体測定', () => {
  const teacher: SessionUser = {
    account_id: 3, email: 'suzuki@hoiku.example.jp', role: '2', display_name: '鈴木 浩之',
    staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
    is_temp_password: false, terms_agreed: true,
  };

  it('同じ園児・同じ測定日は、上書きを承諾したときに上書きになる（部分一意インデックス）', async () => {
    const first = await api.save(teacher, { child_id: 'C009', measured_on: '2026-09-01', height_cm: 77.0, weight_kg: 9.2 });
    // 確かめずに送ると書き換えない（基本設計書「身体測定の記録」(4-8)「上書き確認を表示する」。GitHub Issue #165）
    await expect(api.save(teacher, { child_id: 'C009', measured_on: '2026-09-01', height_cm: 77.5, weight_kg: 9.3 }))
      .rejects.toThrow('この測定日の記録は登録済みです');
    const second = await api.save(teacher, {
      child_id: 'C009', measured_on: '2026-09-01', height_cm: 77.5, weight_kg: 9.3, confirm_overwrite: true,
    });
    expect(second.physical_record_id).toBe(first.physical_record_id);
    expect(second.height_cm).toBe(77.5);
  });

  it('未来日は登録できない', async () => {
    await expect(api.save(teacher, { child_id: 'C009', measured_on: '2099-01-01', height_cm: 80, weight_kg: 10 }))
      .rejects.toThrow('未来日');
  });

  it('範囲外の値は警告を返すが、登録自体は妨げない（判定ではないため）', async () => {
    expect(api.rangeWarning(200, 10)).toContain('身長');
    expect(api.rangeWarning(80, 10)).toBeNull();
    const saved = await api.save(teacher, { child_id: 'C010', measured_on: '2026-09-01', height_cm: 200, weight_kg: 10 });
    expect(saved.height_cm).toBe(200);
  });

  it('性別が未回答の園児には成長曲線の基準値を持たない', async () => {
    expect(await api.growthBand('9', '1')).toBeNull();
    expect((await api.growthBand('1', '1'))?.length).toBeGreaterThan(0);
  });
});

describe('招待コードの入力形式とメールアドレスの検査', () => {
  const unused = () => db.invitationCodes.find((c) => c.status === '1' && c.expires_on >= today())!;

  it('ハイフンを省いても、小文字でも、正しいコードは確認できる', async () => {
    const code = unused().code;
    await expect(api.verifyInvitationCode(code.replace(/-/g, '').toLowerCase())).resolves.toBeTruthy();
    await expect(api.verifyInvitationCode(` ${code.toLowerCase()} `)).resolves.toBeTruthy();
    await expect(api.verifyInvitationCode(code)).resolves.toBeTruthy();
  });

  it('メールアドレスが空・形式の誤りのままでは登録できない', async () => {
    const base = { code: unused().code, password: 'pass12345', guardian_name: '検査 太郎', relationship: '父',
      terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
    };
    await expect(api.signUpGuardian({ ...base, email: '' })).rejects.toThrow(/メールアドレスを入力/);
    await expect(api.signUpGuardian({ ...base, email: '   ' })).rejects.toThrow(/メールアドレスを入力/);
    await expect(api.signUpGuardian({ ...base, email: 'taro.example.jp' })).rejects.toThrow(/形式/);
    // 検査で止まったコードは使われていない
    expect(unused().code).toBe(base.code);
  });

  it('園児1人に1枚だけ発行できる。ほかの園児のコードは増えない', async () => {
    const before = db.invitationCodes.length;
    const code = await api.issueOneInvitationCode(admin, 'C001', 30);
    expect(db.invitationCodes.length).toBe(before + 1);
    expect(db.invitationCodes.find((c) => c.code === code)!.child_id).toBe('C001');
  });
});
