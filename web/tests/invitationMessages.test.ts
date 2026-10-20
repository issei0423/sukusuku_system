/*
 * 招待コードの誤りの文言（モック）
 * 典拠：基本設計書「メッセージ一覧」(4-12) の招待コードの4つ・「保護者アカウントの自己登録」(4-3)・
 *      「お子さまの追加（園児の追加紐づけ）」(4-3)、詳細設計書「お子さまの追加」(4-15 (1))・決めたこと D-52
 *
 * 新規登録のコードの確認・新規登録の送信・お子さまの追加（確認と追加）の、どの経路でも同じ4つの文言を返す。
 * Go の同じ観点は server/api_invitation_messages_test.go にある（invitationMessageCases は同じ名前の表と同じ行）。
 * 同じコードを同時に送ったときの2つ目はサーバだけの観点（モックは待たずに処理するため起きない）。
 * mockDb は同じファイルのテストどうしで使い回されるため、書き換える表は beforeEach で写し、afterEach で戻す。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { MSG } from '../src/messages';
import type { SessionUser } from '../src/api/types';

/*
 * 設計書の4つの文言を、そのまま写したもの（基本設計書「メッセージ一覧」(4-12)）。web/src/messages.ts の MSG を使わずに
 * 文字で持つのは、MSG の書き換えで文言が設計から離れたときにも気づくため
 */
const NOT_FOUND = '招待コードが確認できません。園から配布されたコードをお確かめください';
const USED = 'この招待コードはすでに使われています。園に新しい招待コードの発行をご依頼ください';
const REVOKED = 'この招待コードは失効しています。園に新しい招待コードの発行をご依頼ください';
const EXPIRED = 'この招待コードは有効期限が切れています。園に新しい招待コードの発行をご依頼ください';

// 野原 太郎（C001）の保護者（mockDb.ts。server/seed.sql と同じ）
const taroGuardian: SessionUser = {
  account_id: 6, email: '6@example.jp', role: '3', display_name: 'アカウント6',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

// server/api_guardian_add_test.go と同じコード
const codeHanako = 'QRST-9012-UVWX'; // C002（上園 花子）の未使用のコード
const codeUsed = 'IJKL-5678-MNOP';
const codeRevoked = 'YZAB-3456-CDEF';

const child = (id: string) => db.children.find((c) => c.child_id === id)!;
const codeOf = (code: string) => db.invitationCodes.find((x) => x.code === code)!;

type Case = { name: string; code: string; message: string; setup?: () => void };
/** server/api_invitation_messages_test.go の invitationMessageCases と同じ行 */
const invitationMessageCases: Case[] = [
  { name: '無いコード', code: 'ZZZZ-0000-ZZZZ', message: NOT_FOUND },
  { name: '取り消した園児のコード', code: codeHanako, message: NOT_FOUND, setup: () => { child('C002').is_deleted = true; } },
  { name: '在籍していない園児のコード', code: codeHanako, message: NOT_FOUND, setup: () => { child('C002').enrollment_status = '2'; } },
  { name: '使用済み', code: codeUsed, message: USED },
  { name: '失効', code: codeRevoked, message: REVOKED },
  { name: '期限切れ', code: codeHanako, message: EXPIRED, setup: () => { codeOf(codeHanako).expires_on = '2000-01-01'; } },
];

/** 断られた理由の文言（断られなければ空） */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

let saved: { children: typeof db.children; codes: typeof db.invitationCodes; links: typeof db.guardianChildren; accounts: number };
beforeEach(() => {
  saved = {
    children: structuredClone(db.children), codes: structuredClone(db.invitationCodes),
    links: structuredClone(db.guardianChildren), accounts: db.accounts.length,
  };
});
afterEach(() => {
  db.children.splice(0, db.children.length, ...saved.children);
  db.invitationCodes.splice(0, db.invitationCodes.length, ...saved.codes);
  db.guardianChildren.splice(0, db.guardianChildren.length, ...saved.links);
});

describe('招待コードの誤りの文言は、どの経路でも同じ4つ（決めたこと D-52）', () => {
  it.each(invitationMessageCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    c.setup?.();
    const routes: [string, Promise<unknown>][] = [
      ['新規登録のコードの確認', api.verifyInvitationCode(c.code)],
      ['新規登録の送信', api.signUpGuardian({
        code: c.code, email: 'invitation.message@example.jp', password: 'invite-pass-5678',
        guardian_name: '検査 太郎', relationship: '母', terms_agreed: true, terms_version: db.CURRENT_TERMS_VERSION,
      })],
      ['お子さまの追加のコードの確認', api.verifyInvitationCode(c.code, taroGuardian)],
      ['お子さまの追加', api.addChild(taroGuardian, c.code, '母')],
    ];
    const got: Record<string, string> = {};
    for (const [name, p] of routes) got[name] = await refusal(p);
    expect(got).toEqual(Object.fromEntries(routes.map(([name]) => [name, c.message])));
    // どの経路でも、書いていない
    expect(db.accounts.length).toBe(saved.accounts);
    expect(db.guardianChildren.find((g) => g.guardian_id === 'G001' && g.child_id === 'C002')).toBeUndefined();
  });

  it('画面とモックが持つ文言（MSG）は、設計書の4つと同じ', () => {
    expect([MSG.invitationNotFound, MSG.invitationUsed, MSG.invitationRevoked, MSG.invitationExpired])
      .toEqual([NOT_FOUND, USED, REVOKED, EXPIRED]);
  });
});
