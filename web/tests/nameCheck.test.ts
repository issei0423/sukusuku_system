/*
 * 他児の名前の照合（モック）
 * 典拠：詳細設計書「他児の名前の照合」(4-5 (2))・「2か所の規則をそろえる」(9-2)、決めたこと D-13・D-17
 *
 * nameCheckCases は server/namecheck_test.go の同じ名前の表と同じ行にする。デモデータに頼らず、作り物の園児で確かめる。
 */
import { describe, it, expect } from 'vitest';
import { findOtherNames } from '../src/api/mock';
import type { NameChild } from '../src/api/mock';

const children: NameChild[] = [
  { id: 'A', name: '野原 太郎', kana: 'のはら たろう', nickname: 'たっくん' },
  { id: 'B', name: '伊藤 葵', kana: 'いとう あおい', nickname: 'あおちゃん' },
  { id: 'C', name: '小林 結衣', kana: 'こばやし ゆい', nickname: 'ゆいちゃん' },
  { id: 'D', name: '井上 空', kana: 'いのうえ そら', nickname: '' },
  { id: 'E', name: '前田 詩', kana: 'まえだ うた', nickname: '' },
  { id: 'F', name: '林 悠真', kana: 'はやし ゆうま', nickname: '' },
  { id: 'G', name: '山田 ゆい', kana: 'やまだ ゆい', nickname: '' },
];

/** server/namecheck_test.go の nameCheckCases と同じ行（宛先が空ならクラスあて） */
const nameCheckCases: [name: string, recipient: string, text: string, names: string[], matches: [number, number][]][] = [
  ['宛先の子の呼び名は当てない', 'A', 'たっくんは砂場で遊びました。', [], []],
  ['ほかの子の呼び名に当たる', 'A', 'あおちゃんと砂場で遊びました。', ['伊藤 葵'], [[0, 5]]],
  ['よみのカタカナに当たる', 'A', 'アオイちゃんと遊びました。', ['伊藤 葵'], [[0, 3]]],
  ['氏名（空白なし）に当たる', 'A', '伊藤葵さんと遊びました。', ['伊藤 葵'], [[0, 3]]],
  ['氏名（半角の空白）に当たる', 'A', '伊藤 葵さんと遊びました。', ['伊藤 葵'], [[0, 4]]],
  ['よみ（全角の空白）に当たる', 'A', 'いとう　あおいさんと遊びました。', ['伊藤 葵'], [[0, 7]]],
  ['1文字の名はふだんの言葉に当てない', 'A', '空が青い日でした。', [], []],
  ['1文字の名に敬称が続けば当たる', 'A', '空くんと遊びました。', ['井上 空'], [[0, 1]]],
  ['2文字以下の仮名はふだんの言葉に当てない', 'A', 'うたをうたいました。', [], []],
  ['2文字以下の仮名に敬称が続けば当たる', 'A', 'うたちゃんと歌いました。', ['前田 詩'], [[0, 2]]],
  ['1文字の姓に敬称が続けば当たる（ほかの子の姓の中でも）', 'A', '小林さんと林の中を歩きました。', ['小林 結衣', '林 悠真'], [[0, 2]]],
  ['宛先と同じ名の子を数えない（呼び名）', 'C', 'ゆいちゃんが笑っていました。', [], []],
  ['宛先と同じ名の子を数えない（よみ）', 'G', 'ゆいちゃんが笑っていました。', [], []],
  ['同じ名の子が2人いれば両方に当たる', 'A', 'ゆいちゃんと遊びました。', ['小林 結衣', '山田 ゆい'], [[0, 5]]],
  ['クラスあては在籍園児の全員が相手', '', 'たっくんとあおちゃんが遊びました。', ['野原 太郎', '伊藤 葵'], [[0, 4], [5, 10]]],
  ['名前が無ければ当たらない', 'A', '園庭で砂場あそびをしました。', [], []],
];

describe('他児の名前の照合（server/namecheck.go と同じ表）', () => {
  it.each(nameCheckCases)('%s', (_name, recipient, text, names, matches) => {
    const got = findOtherNames(text, 'body', children.filter((c) => c.id === recipient), children);
    expect(got.names).toEqual(names);
    expect(got.matches.map((m) => [m.start, m.end])).toEqual(matches);
    expect(got.matches.every((m) => m.field === 'body')).toBe(true);
  });
});
