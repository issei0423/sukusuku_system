// @vitest-environment jsdom
/*
 * 職員のチャット画面：「保護者との個人チャット」を園児の名前で絞り込む
 * 典拠：図/画面詳細図.md「チャット画面（職員・タブレット／PC）」(4-1) 項目24「個人チャットの絞り込み」のうち園児名の文字の入力
 *      web/仮置き値.md「個人チャットの絞り込み」（置き方・文言・一致のしかた・消し方）
 *
 * 管理者は全クラスの家庭の個人チャットが並び、一覧があふれる。名前の一部で絞れること、空白を問わないこと、
 * 0 件の文、消すと戻ること、開いているチャンネルを閉じないこと、ほかの欄を絞らないことを確かめる。
 * 相手はモック（api/mock.ts）。部屋の名前はデモデータ（mockDb.ts の chatRooms：「園児名の保護者」）のまま。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import * as db from '../src/api/mockDb';
import { normalizeRoomQuery, matchesRoomQuery, childNameOfRoom } from '../src/screens/chat/roomSearch';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'nishida@hoiku.example.jp', role: '1', display_name: '西田 拓也', staff_id: 'S001',
  guardian_id: null, class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
};

function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={admin}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
    expect(document.querySelector('button.channel')).toBeTruthy();
  }, { timeout: 3000 });
}

afterEach(cleanup);

/** 欄の見出しから、その欄に並んだチャンネルの名前を取る */
const groupOf = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.channel-group'))
  .find((g) => g.textContent === label)?.parentElement ?? null;
const namesIn = (label: string) => Array.from(groupOf(label)?.querySelectorAll<HTMLButtonElement>('button.channel') ?? [])
  .map((b) => b.querySelector('span')?.firstChild?.textContent ?? '');
const search = () => screen.getByLabelText('園児の名前で探す') as HTMLInputElement;
const type = (value: string) => fireEvent.change(search(), { target: { value } });
/** 絞り込みの件数を伝える領域（role="status"）。欄の中のものだけを見る */
const countStatus = () => groupOf('保護者との個人チャット')!.querySelector<HTMLElement>('[role="status"]')!;
const PERSONAL = '保護者との個人チャット';
// 管理者に並ぶ個人チャット（参加の行があるもの）。デモの園児の数だけある
const allPersonal = () => db.chatRooms.filter((r) => r.room_type === '4' &&
  db.chatMembers.some((m) => m.chat_room_id === r.chat_room_id && m.account_id === admin.account_id && m.left_at === null)).length;

describe('一致のしかた（roomSearch.ts）', () => {
  it('空白（半角・全角）を除き、英字の大文字・小文字と全角・半角をそろえる', () => {
    expect(normalizeRoomQuery(' 西田　太郎 ')).toBe('西田太郎');
    expect(normalizeRoomQuery('ＡＢｃ　d')).toBe('abcd');
  });

  it('照らすのは園児名の部分。「の保護者」「の園とのやりとり」の字では当てない', () => {
    const room = { room_name: '西田 太郎の保護者' };
    expect(childNameOfRoom(room)).toBe('西田 太郎');
    expect(matchesRoomQuery(room, '太郎')).toBe(true);
    expect(matchesRoomQuery(room, '西田太郎')).toBe(true);
    expect(matchesRoomQuery(room, '保護者')).toBe(false);
    expect(matchesRoomQuery(room, '園')).toBe(false);
    expect(matchesRoomQuery({ room_name: 'Emma Smithの保護者' }, 'emmas')).toBe(true);
    // 空・空白だけのときは、すべて当たる
    expect(matchesRoomQuery(room, '　 ')).toBe(true);
  });
});

describe('「保護者との個人チャット」の絞り込み（画面詳細図 4-1 項目24）', () => {
  it('名前の一部で、その欄の行だけに絞る。件数を読み上げへ伝え、未対応の印はそのまま', async () => {
    open('/staff/chat');
    await settled();
    expect(namesIn(PERSONAL)).toHaveLength(allPersonal());
    expect(allPersonal()).toBeGreaterThan(10);

    type('西田');
    expect(namesIn(PERSONAL)).toEqual(['西田 太郎の園とのやりとり']);
    expect(countStatus().textContent).toBe('1 件');
    // 未対応の印（デモの西田 太郎の個人チャットは未対応）は、絞っても行に残る
    expect(groupOf(PERSONAL)!.querySelector('button.channel .mark')?.textContent).toBe('未対応');

    type('田');
    const hits = namesIn(PERSONAL);
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.every((n) => n.replace(/の園とのやりとり$/, '').includes('田'))).toBe(true);
    expect(countStatus().textContent).toBe(`${hits.length} 件`);
  });

  it('空白（半角・全角）を入れても入れなくても当たる', async () => {
    open('/staff/chat');
    await settled();
    for (const q of ['西田太郎', '西田 太郎', '西田　太郎', ' 太郎 ']) {
      type(q);
      expect(namesIn(PERSONAL), q).toEqual(['西田 太郎の園とのやりとり']);
    }
  });

  it('当たらないときは「見つかりません」を出す。欄の見出しと検索欄は残る', async () => {
    open('/staff/chat');
    await settled();
    type('該当のない名前');
    expect(namesIn(PERSONAL)).toEqual([]);
    expect(groupOf(PERSONAL)).toBeTruthy();
    expect(countStatus().textContent).toBe('見つかりません');
    expect(countStatus().className).toBe('channel-search-empty');
    expect(search().value).toBe('該当のない名前');
  });

  it('「消す」で空にすると、すべての行が戻り、フォーカスは入力欄へ戻る。Esc でも空にできる', async () => {
    open('/staff/chat');
    await settled();
    expect(screen.queryByRole('button', { name: '入れた文字を消す' })).toBeNull();
    type('西田');
    const clear = screen.getByRole('button', { name: '入れた文字を消す' });
    expect(clear.textContent).toBe('消す');
    fireEvent.click(clear);
    expect(search().value).toBe('');
    expect(namesIn(PERSONAL)).toHaveLength(allPersonal());
    expect(document.activeElement).toBe(search());
    expect(countStatus().textContent).toBe('');
    expect(screen.queryByRole('button', { name: '入れた文字を消す' })).toBeNull();

    type('遠藤');
    expect(namesIn(PERSONAL)).toEqual(['遠藤 花子の園とのやりとり']);
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(search().value).toBe('');
    expect(namesIn(PERSONAL)).toHaveLength(allPersonal());
  });

  it('変換の途中の Esc では消さない（変換の取り消しのため）', async () => {
    open('/staff/chat');
    await settled();
    type('西田');
    fireEvent.keyDown(search(), { key: 'Escape', isComposing: true });
    expect(search().value).toBe('西田');
  });

  it('開いているチャンネルは、絞り込みで当たらなくなっても閉じない', async () => {
    open('/staff/chat?room=7');
    await settled();
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('遠藤 花子の園とのやりとり'));
    const title = () => document.querySelectorAll<HTMLElement>('.chat-pane > h2')[1].textContent;
    expect(title()).toContain('遠藤 花子の園とのやりとり');

    type('西田');
    expect(namesIn(PERSONAL)).toEqual(['西田 太郎の園とのやりとり']);
    // 一覧の行は隠れても、メッセージ領域と投稿欄は遠藤 花子の家庭のまま
    expect(title()).toContain('遠藤 花子の園とのやりとり');
    expect(screen.getByPlaceholderText('メッセージを入力')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '入れた文字を消す' }));
    expect(document.querySelector('.channel.current')?.textContent).toContain('遠藤 花子の園とのやりとり');
  });

  it('ほかの欄（園・職員、クラス・グループ、外れたチャンネル）は絞らない', async () => {
    open('/staff/chat');
    await settled();
    const others = ['園・職員', 'クラス・グループ', '外れたチャンネル（閲覧のみ）'];
    const before = Object.fromEntries(others.map((g) => [g, namesIn(g)]));
    expect(before['クラス・グループ']).toContain('さくら組');

    // 「さくら」は園児名に無い（クラス名にはある）。個人チャットだけが 0 件になり、クラスの欄は変わらない
    type('さくら');
    expect(namesIn(PERSONAL)).toEqual([]);
    for (const g of others) expect(namesIn(g), g).toEqual(before[g]);
    // 検索欄は個人チャットの欄にだけある
    expect(screen.getAllByLabelText('園児の名前で探す')).toHaveLength(1);
  });
});
