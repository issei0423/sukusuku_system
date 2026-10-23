/*
 * 他児の名前の照合（モック）
 * 典拠：詳細設計書「他児の名前の照合」(4-5 (2))・「2か所の規則をそろえる」(9-2)、決めたこと D-13・D-17
 *
 * nameCheckCases は server/namecheck_test.go の同じ名前の表と同じ行にする。デモデータに頼らず、作り物の園児で確かめる。
 */
import { describe, it, expect } from 'vitest';
import { findOtherNames, findOtherNamesFor, checkOtherNames, otherNamesHitMessage, nameCheckExclusions } from '../src/api/mock';
import type { NameChild } from '../src/api/mock';

const children: NameChild[] = [
  { id: 'A', name: '西田 太郎', kana: 'にしだ たろう', nickname: 'たっくん' },
  { id: 'B', name: '伊藤 葵', kana: 'いとう あおい', nickname: 'あおちゃん' },
  { id: 'C', name: '小林 結衣', kana: 'こばやし ゆい', nickname: 'ゆいちゃん' },
  { id: 'D', name: '井上 空', kana: 'いのうえ そら', nickname: '' },
  { id: 'E', name: '前田 詩', kana: 'まえだ うた', nickname: '' },
  { id: 'F', name: '林 悠真', kana: 'はやし ゆうま', nickname: '' },
  { id: 'G', name: '山田 ゆい', kana: 'やまだ ゆい', nickname: '' },
  { id: 'H', name: '西田 あい', kana: 'にしだ あい', nickname: '' },
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
  ['クラスあては在籍園児の全員が相手', '', 'たっくんとあおちゃんが遊びました。', ['西田 太郎', '伊藤 葵'], [[0, 4], [5, 10]]],
  ['名前が無ければ当たらない', 'A', '園庭で砂場あそびをしました。', [], []],
  ['同じ姓のきょうだいの氏名は、宛先の姓に重なっても当たる', 'A', '西田あいに伝えました。', ['西田 あい'], [[0, 4]]],
  ['宛先の姓だけなら、同じ姓のきょうだいに当てない', 'A', '西田さんに伝えました。', [], []],
];

describe('他児の名前の照合（server/namecheck.go と同じ表）', () => {
  it.each(nameCheckCases)('%s', (_name, recipient, text, names, matches) => {
    const got = findOtherNames(text, 'body', children.filter((c) => c.id === recipient), children);
    expect(got.names).toEqual(names);
    expect(got.matches.map((m) => [m.start, m.end])).toEqual(matches);
    expect(got.matches.every((m) => m.field === 'body')).toBe(true);
  });
});

/*
 * 届く家庭ごとの照合と、照合の前に除く語（詳細設計書 4-5 (2) の③の2・④、「写真」(4-4 (2))）。
 * nameFamilyCases は server/namecheck_family_test.go の同じ名前の表と同じ行にする
 */
const familyChildren: NameChild[] = [
  ...children,
  { id: 'I', name: '松本 咲良', kana: 'まつもと さくら', nickname: '' },
  { id: 'J', name: '鈴木 健', kana: 'すずき けん', nickname: '' },
];
const suzuki = ['鈴木先生', '鈴木せんせい', '鈴木浩之先生', '鈴木浩之せんせい', '鈴木 浩之先生', '鈴木 浩之せんせい', '鈴木　浩之先生', '鈴木　浩之せんせい'];

const nameFamilyCases: [name: string, families: string[][], excluded: string[], text: string, names: string[], matches: [number, number][]][] = [
  ['写っているもう1人の呼び名は、その子でない家庭への送信で当たる', [['A'], ['B']], [], 'たっくんが初めてひとりで立ちました。', ['西田 太郎'], [[0, 4]]],
  ['写っている2人の名前が両方あれば両方に当たる', [['A'], ['B']], [], 'たっくんとあおちゃんが遊びました。', ['西田 太郎', '伊藤 葵'], [[0, 4], [5, 10]]],
  ['写っていない子の名前は、家庭ごとの当たりを1つの位置にまとめる', [['A'], ['B']], [], 'ゆいちゃんと遊びました。', ['小林 結衣', '山田 ゆい'], [[0, 5]]],
  ['家庭が1つなら今までと同じ', [['A']], [], 'たっくんは砂場で遊びました。', [], []],
  ['クラス名の中の名前は当てない', [['A']], ['さくら組'], 'さくら組のみなさんと遊びました。', [], []],
  ['クラス名の外の同じ名前は当てる', [['A']], ['さくら組'], 'さくら組のさくらちゃん', ['松本 咲良'], [[5, 8]]],
  ['「姓＋先生」の中の名前は当てない', [['A']], suzuki, '鈴木先生と散歩しました。', [], []],
  ['「せんせい」も除く', [['A']], suzuki, '鈴木せんせいと散歩しました。', [], []],
  ['「姓＋先生」の外の園児の氏名は当てる', [['A']], suzuki, '鈴木健くんと鈴木先生', ['鈴木 健'], [[0, 3]]],
];

describe('届く家庭ごとの照合と除く語（server/namecheck_family_test.go と同じ表）', () => {
  it.each(nameFamilyCases)('%s', (_name, families, excluded, text, names, matches) => {
    const fams = families.map((f) => familyChildren.filter((c) => f.includes(c.id)));
    const got = findOtherNamesFor(text, 'body', fams, familyChildren, excluded);
    expect(got.names).toEqual(names);
    expect(got.matches.map((m) => [m.start, m.end])).toEqual(matches);
  });

  it('除く語は、今年度のクラス名と職員の「姓＋先生」「氏名＋先生」', () => {
    const words = nameCheckExclusions();
    expect(words).toEqual(expect.arrayContaining(['さくら組', ...suzuki]));
  });

  it('デモデータで：「さくら組」「鈴木先生」で注意が出ない。2人が写った写真は家庭ごとに照合し、家庭の数を添える', () => {
    expect(checkOtherNames('さくら組のみなさんと鈴木先生と散歩しました。', 'body', ['C001'], false)).toBeNull();
    expect(checkOtherNames('鈴木健くんと鈴木先生と散歩しました。', 'body', ['C001'], false)?.names).toEqual(['鈴木 健']);
    const hit = checkOtherNames('たっくんが初めてひとりで立ちました。', 'body', ['C001', 'C006'], false);
    expect(hit?.names).toEqual(['西田 太郎']);
    expect(otherNamesHitMessage(hit!)).toBe('ほかのお子さんの名前（西田 太郎）が入っています。このまま送りますか。この文は写っている全員（2 家庭）に届きます。');
    expect(checkOtherNames('たっくんが初めてひとりで立ちました。', 'body', ['C001', 'C006'], false, ['西田 太郎'])).toBeNull();
    // 宛先が1人なら、家庭の数を添えない
    const one = checkOtherNames('あおちゃんと遊びました。', 'body', ['C001'], false);
    expect(otherNamesHitMessage(one!)).toBe('ほかのお子さんの名前（伊藤 葵）が入っています。このまま送りますか。');
  });
});
