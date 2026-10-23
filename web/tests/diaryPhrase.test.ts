/*
 * 日誌の定型文と、デモのヒヤリハットの本文
 * 典拠：ナレッジ/決定事項.md 2026-10-18「『日誌』は園内の保育日誌として連絡帳とは別に持ち、保護者へは連絡帳で届ける」、
 *      基本設計書「ヒヤリハットの記録」(4-6)、詳細設計書「デモデータ」(5-5)・決めたこと D-33（PR #216 で設計を直した）
 *
 * Go サーバ側（server/api_diary_phrase_test.go）と同じ観点を、モック（api/mock.ts）に対して確かめる。
 * デモデータを2か所（server/seed.sql と api/mockDb.ts）に持っているため、片方だけを直すと食い違う（AGENTS.md）。
 */
import { describe, it, expect } from 'vitest';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

/** 日誌の定型文。server/api_diary_phrase_test.go と同じ並び */
const wantPhrases = [
  'よく食べ、おかわりをしていました。',
  '午睡は落ち着いて入眠できました。',
  '園庭で友だちと関わって遊ぶ姿が見られました。',
  '鼻水が出ていたため、こまめに拭き取りました。',
];

/** デモのヒヤリハット（diary_id 3）の今後の対策。server/api_diary_phrase_test.go と同じ文 */
const wantCountermeasure =
  '午睡の確認のたびに、呼吸とあわせて体位も見る。うつ伏せを見つけて仰向けに直したときは、直したあとの向きも記録する。';

describe('日誌の定型文', () => {
  it('保護者に向けた文を候補に出さない（日誌は園内の記録）', async () => {
    const phrases = await api.phrases();
    expect(phrases).toEqual(wantPhrases);
    for (const p of phrases) {
      expect(p).not.toMatch(/ご家庭|保護者/);
    }
  });
});

describe('デモのヒヤリハット', () => {
  it('雛形と同じ【今後の対策】の見出しで、今後の対策を持つ', async () => {
    const d = await api.getDiary(admin, 3);
    expect(d.record_type).toBe('4');
    // 見出しは雛形（diaryTemplates の 4）と同じ順に並ぶ。
    // 発生日時は列（occurred_at）へ移ったので、本文の見出しには無い（#230。詳細設計書「日誌」(4-13 (1))、決めたこと D-33）
    const template = db.diaryTemplates.find((t) => t.record_type === '4');
    expect(template?.body).toContain('【今後の対策】');
    let pos = -1;
    for (const heading of ['【状況】', '【とった対応】', '【今後の対策】']) {
      const i = d.body.indexOf(heading);
      expect(i, `見出し ${heading} が無いか、順が違う`).toBeGreaterThan(pos);
      pos = i;
    }
    expect(d.body.split('【今後の対策】')[1].trim()).toBe(wantCountermeasure);
  });
});
