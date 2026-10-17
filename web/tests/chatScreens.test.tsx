// @vitest-environment jsdom
/*
 * チャットの画面とグループ編成画面（GitHub Issue #172・#171・#141）
 * 典拠：図/画面詳細図.md「チャット画面（職員）」(4-1)・「チャット画面（保護者）」(4-2)・「グループ編成画面」(4-3)
 *      基本設計書「一覧表示とページング」(3-7)「チャットのメッセージ｜直近から遡って」・「誤送信への対応」(4-6)
 *      web/仮置き値.md「開いているチャンネルに届いたメッセージ」
 *
 * 書きかけの本文が別の家庭へ送れないこと、開いたら最新から見せること、取消の前に確かめること、
 * 管理者が他者のメッセージを画面から削除できること、操作のあとのフォーカス、グループ編成画面の一覧を確かめる。
 * 相手はモック（api/mock.ts）。デモデータはこのファイルの中で使い回すため、テストごとに新しいメッセージを送って使う。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { useFollowLatest } from '../src/hooks';
import { formatMD } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const user = (account_id: number, role: '1' | '2' | '3', email: string, display_name: string,
  extra: Partial<SessionUser> = {}): SessionUser => ({
  account_id, email, role, display_name, staff_id: null, guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true, ...extra,
});
const admin = user(1, '1', 'nohara@hoiku.example.jp', '野原 一誠', { staff_id: 'S001' });
const teacher = user(3, '2', 'takanashi@hoiku.example.jp', '高梨 倫太朗', { staff_id: 'S003', class_id: 1, class_name: 'さくら組' });
const kinjo = user(5, '2', 'kinjo@hoiku.example.jp', '金城 宗一郎', { staff_id: 'S005', class_id: 2, class_name: 'ひまわり組' });
const miyagi = user(9, '3', 'miyagi.r@example.jp', '宮城 蓮', { guardian_id: 'G004' });

function open(path: string, u: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={u}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

afterEach(cleanup);

const composer = () => screen.getByPlaceholderText('メッセージを入力') as HTMLTextAreaElement;
const channel = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button.channel'))
  .find((b) => b.textContent?.includes(name))!;
/** 本文から、そのメッセージの行（.msg）を探す */
const rowOf = (body: string) => Array.from(document.querySelectorAll<HTMLElement>('.msg'))
  .find((m) => m.querySelector('.bubble')?.textContent?.includes(body)) ?? null;
const findRow = async (body: string) => {
  await waitFor(() => expect(rowOf(body)).toBeTruthy(), { timeout: 3000 });
  return rowOf(body)!;
};
const openMenu = (row: HTMLElement) => fireEvent.click(row.querySelector('.message-actions-trigger')!);
const isRetracted = (id: number) => db.chatMessages.find((m) => m.chat_message_id === id)!.is_deleted;

describe('書きかけの本文は、書いていたチャンネルにだけ結び付く（GitHub Issue #172 の 2）', () => {
  it('職員：チャンネルを切り替えると入力欄は空になり、別の家庭へは送れない。戻ると書きかけが戻る', async () => {
    open('/staff/chat?room=8', teacher);
    await settled();
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('宮城 美咲の保護者'));
    fireEvent.change(composer(), { target: { value: 'A1 美咲ちゃんは今日、少し熱っぽかったです。' } });

    fireEvent.click(channel('金城 陸の保護者'));
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('金城 陸の保護者'));
    expect(composer().value).toBe('');
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(composer(), { target: { value: 'B1 陸くんのお迎えの件です。' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await findRow('B1 陸くんのお迎えの件です。');
    expect(db.chatMessages.some((m) => m.chat_room_id === 9 && m.body.startsWith('A1'))).toBe(false);
    expect(composer().value).toBe('');

    fireEvent.click(channel('宮城 美咲の保護者'));
    await waitFor(() => expect(document.querySelector('.channel.current')?.textContent).toContain('宮城 美咲の保護者'));
    expect(composer().value).toBe('A1 美咲ちゃんは今日、少し熱っぽかったです。');
  });

  it('保護者：きょうだいの個人チャットを切り替えても、書きかけは持ち越さない', async () => {
    // 宮城 蓮に、上園 花子の家庭の個人チャット（room 7）をきょうだいのものとして足す（画面の確かめのためだけ）
    const sibling = { chat_room_id: 7, account_id: 9, joined_at: '2025-07-01T10:00:00', left_at: null };
    db.chatMembers.push(sibling);
    try {
      open('/guardian/chat', miyagi);
      await settled();
      const rooms = () => screen.getAllByText('担任の先生とのやりとり');
      await waitFor(() => expect(rooms()).toHaveLength(2));
      fireEvent.click(rooms()[1].closest('button')!);
      const input = await screen.findByRole('textbox', { name: 'メッセージを入力' }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: '美咲の熱のことです' } });
      fireEvent.click(screen.getByText('< もどる'));
      fireEvent.click((await screen.findAllByText('担任の先生とのやりとり'))[0].closest('button')!);
      const other = await screen.findByRole('textbox', { name: 'メッセージを入力' }) as HTMLInputElement;
      expect(other.value).toBe('');
    } finally {
      db.chatMembers.splice(db.chatMembers.indexOf(sibling), 1);
    }
  });
});

describe('チャンネルを開いたら、いちばん下（最新）から見せる（GitHub Issue #172 の 1）', () => {
  // jsdom は配置を計算しないため、送れる量と見えている量を決めて置く
  function withScrollBox() {
    const proto = HTMLElement.prototype;
    const saved = ['scrollHeight', 'clientHeight', 'scrollTop'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    const tops = new WeakMap<HTMLElement, number>();
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) { return tops.get(this) ?? 0; },
      set(this: HTMLElement, v: number) { tops.set(this, v); },
    });
    return () => saved.forEach(([k, d]) => (d ? Object.defineProperty(proto, k, d) : delete (proto as never)[k]));
  }
  function Probe({ scope, latest }: { scope: number | null; latest: number | null }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useFollowLatest(ref, scope, latest);
    return <div ref={ref} data-testid="box" style={{ overflowY: 'auto' }} />;
  }

  it('開いた直後といちばん下を読んでいるときは下へ送り、上へ戻って読んでいるときは動かさない', () => {
    const restore = withScrollBox();
    try {
      const view = render(<Probe scope={null} latest={null} />);
      const box = screen.getByTestId('box');
      // チャンネルのメッセージが届いた（開いた）
      view.rerender(<Probe scope={8} latest={30} />);
      expect(box.scrollTop).toBe(1000);
      // 上へ戻って読んでいるときに届いたものでは動かさない
      act(() => { box.scrollTop = 0; });
      view.rerender(<Probe scope={8} latest={31} />);
      expect(box.scrollTop).toBe(0);
      // 別のチャンネルへ切り替えたら、そのチャンネルの最新から見せる
      view.rerender(<Probe scope={9} latest={40} />);
      expect(box.scrollTop).toBe(1000);
    } finally {
      restore();
    }
  });
});

describe('取消は確かめてから行い、できなかったときは知らせる（GitHub Issue #141 の 2・#171 の 7）', () => {
  it('職員：「取消」を押しても、確かめるまでは取り消さない。やめると何も変わらない', async () => {
    const sent = await api.send(teacher, 8, 'C1 明日の持ち物は水筒です。');
    open('/staff/chat?room=8', teacher);
    await settled();
    openMenu(await findRow('C1 明日の持ち物は水筒です。'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('元に戻せません');
    expect(isRetracted(sent.chat_message_id)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(isRetracted(sent.chat_message_id)).toBe(false);

    openMenu(rowOf('C1 明日の持ち物は水筒です。')!);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(await screen.findByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(isRetracted(sent.chat_message_id)).toBe(true));
  });

  it('職員：別の画面ですでに取り消されていたら、取り消せなかったことを出す', async () => {
    const sent = await api.send(teacher, 8, 'C2 別のタブで取り消すメッセージ');
    open('/staff/chat?room=8', teacher);
    await settled();
    openMenu(await findRow('C2 別のタブで取り消すメッセージ'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await screen.findByRole('dialog');
    await api.retract(teacher, sent.chat_message_id);
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(document.body.textContent).toContain('このメッセージはすでに取り消されています'));
  });

  it('保護者：「取消」を押しても、確かめるまでは取り消さない', async () => {
    const sent = await api.send(miyagi, 8, 'G1 明日はお休みします');
    open('/guardian/chat', miyagi);
    await settled();
    fireEvent.click(screen.getByText('担任の先生とのやりとり').closest('button')!);
    openMenu(await findRow('G1 明日はお休みします'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await screen.findByRole('dialog');
    expect(isRetracted(sent.chat_message_id)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(isRetracted(sent.chat_message_id)).toBe(true));
  });
});

describe('管理者は、他者の誤送信メッセージをチャット画面から削除できる（GitHub Issue #171 の 3）', () => {
  it('管理者には他者のメッセージに「削除」を出し、既読の有無を示して確かめてから削除する', async () => {
    const sent = await api.send(teacher, 7, 'B1 （誤送信）野原 太郎くんの発熱の記録');
    open('/staff/chat?room=7', admin);
    await settled();
    openMenu(await findRow('B1 （誤送信）野原 太郎くんの発熱の記録'));
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/既読.*0/);
    expect(dialog.textContent).toContain('誤送信対応');
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(isRetracted(sent.chat_message_id)).toBe(true));
  });

  it('保護者の発言の削除は誤送信への対応として扱わず、既読や記録の案内を出さない', async () => {
    const sent = await api.send(miyagi, 8, 'B3 保護者の発言');
    open('/staff/chat?room=8', admin);
    await settled();
    openMenu(await findRow('B3 保護者の発言'));
    fireEvent.click(screen.getByRole('button', { name: '削除' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('保護者のメッセージを削除します');
    expect(dialog.textContent).not.toContain('誤送信');
    expect(dialog.textContent).not.toContain('既読');
    fireEvent.click(screen.getByRole('button', { name: '削除する' }));
    await waitFor(() => expect(isRetracted(sent.chat_message_id)).toBe(true));
  });

  it('一般の職員には、他者のメッセージの削除を出さない', async () => {
    await api.send(admin, 7, 'B2 園長からの連絡です');
    open('/staff/chat?room=7', teacher);
    await settled();
    openMenu(await findRow('B2 園長からの連絡です'));
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
  });
});

describe('操作の一覧を閉じたら、開いた「操作」ボタンへ戻る（GitHub Issue #172 の 3）', () => {
  it('職員：リアクションを選んだあと', async () => {
    await api.send(teacher, 8, 'F1 フォーカスの確かめ（職員）');
    open('/staff/chat?room=8', teacher);
    await settled();
    const row = await findRow('F1 フォーカスの確かめ（職員）');
    openMenu(row);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('了解'));
    fireEvent.click(document.activeElement!);
    await waitFor(() => expect(screen.queryByRole('group', { name: 'メッセージの操作' })).toBeNull());
    expect(document.activeElement).toBe(row.querySelector('.message-actions-trigger'));
  });

  it('保護者：リアクションを選んだあと', async () => {
    await api.send(teacher, 8, 'F2 フォーカスの確かめ（保護者）');
    open('/guardian/chat', miyagi);
    await settled();
    fireEvent.click(screen.getByText('担任の先生とのやりとり').closest('button')!);
    const row = await findRow('F2 フォーカスの確かめ（保護者）');
    openMenu(row);
    fireEvent.click(screen.getByRole('button', { name: '了解' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'メッセージの操作' })).toBeNull());
    expect(document.activeElement).toBe(rowOf('F2 フォーカスの確かめ（保護者）')!.querySelector('.message-actions-trigger'));
  });
});

describe('取り消されたメッセージの表示（GitHub Issue #171 の 6・#141 の 5）', () => {
  it('保護者：誰の・いつのものかを出し、自分のものは自分の側に寄せる', async () => {
    const byStaff = await api.send(teacher, 8, 'R1 職員が取り消す');
    await api.retract(teacher, byStaff.chat_message_id);
    const byMe = await api.send(miyagi, 8, 'R2 保護者が取り消す');
    await api.retract(miyagi, byMe.chat_message_id);

    open('/guardian/chat', miyagi);
    await settled();
    fireEvent.click(screen.getByText('担任の先生とのやりとり').closest('button')!);
    await waitFor(() => expect(document.querySelectorAll('.bubble.retracted').length).toBeGreaterThan(1));
    const rows = Array.from(document.querySelectorAll('.bubble.retracted')).map((b) => b.closest('.msg')!);
    const date = formatMD(byMe.sent_at.slice(0, 10));
    const mine = rows.filter((r) => r.classList.contains('mine'));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.at(-1)!.querySelector('.meta')?.textContent).toContain('私');
    expect(mine.at(-1)!.querySelector('.meta')?.textContent).toContain(date);
    const others = rows.filter((r) => !r.classList.contains('mine'));
    expect(others.at(-1)!.querySelector('.meta')?.textContent).toContain('高梨 倫太朗');
  });

  it('職員：取り消されたメッセージにも日付を出す', async () => {
    open('/staff/chat?room=7', teacher);
    await settled();
    // デモデータの ID 10 は取消済み
    const sentAt = db.chatMessages.find((m) => m.chat_message_id === 10)!.sent_at;
    await waitFor(() => expect(document.querySelector('.bubble.retracted')).toBeTruthy());
    const meta = document.querySelector('.bubble.retracted')!.closest('.msg')!.querySelector('.meta')!;
    expect(meta.textContent).toContain(formatMD(sentAt.slice(0, 10)));
  });
});

describe('送信者が職員か保護者かを吹き出しに添える（GitHub Issue #141 の 1）', () => {
  it('職員の画面：保護者が参加するチャンネルでは、職員・保護者の印を出す', async () => {
    open('/staff/chat?room=6', admin);
    await settled();
    const fromGuardian = await findRow('ありがとうございます。確認しました。');
    const fromStaff = await findRow('今日は砂場でスコップを使って、型抜きを何度もしていました。');
    expect(fromGuardian.querySelector('.sender-role')?.textContent).toBe('保護者');
    expect(fromStaff.querySelector('.sender-role')?.textContent).toBe('職員');
  });
});

describe('グループ編成画面（GitHub Issue #172 の 4・5）', () => {
  it('一般の職員には、参加していないグループを出さない', async () => {
    await api.createGroup(teacher, 'G 遠足下見（高梨・宮城）', [4]);
    open('/staff/chat/groups', kinjo);
    await settled();
    await waitFor(() => expect(screen.getByText('運動会実行委員')).toBeTruthy());
    expect(screen.queryByText('G 遠足下見（高梨・宮城）')).toBeNull();
  });

  it('メンバーを編成して保存すると、一覧のメンバー欄がすぐに新しくなる', async () => {
    await api.updateGroupMembers(admin, 5, [1, 3, 5]);
    open('/staff/chat/groups', admin);
    await settled();
    const rowOfGroup = () => screen.getByText('運動会実行委員').closest('tr')!;
    await waitFor(() => expect(rowOfGroup().textContent).toContain('金城 宗一郎'));
    fireEvent.click(rowOfGroup().querySelector('button')!);
    const dialog = await screen.findByRole('dialog');
    const kinjoBox = Array.from(dialog.querySelectorAll('label')).find((l) => l.textContent?.includes('金城 宗一郎'))!
      .querySelector('input')!;
    await waitFor(() => expect(kinjoBox.checked).toBe(true));
    fireEvent.click(kinjoBox);
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(rowOfGroup().textContent).not.toContain('金城 宗一郎'));
    expect(rowOfGroup().textContent).toContain('高梨 倫太朗');
  });
});
