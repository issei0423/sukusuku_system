// @vitest-environment jsdom
/*
 * 写真を送る画面と、写真の表示（モック）
 * 典拠：詳細設計書「写真を送る」(2-2 (7))・「写真」(3-3)・「きょうのようすを足す・直す」(2-3 (4))・「保護者ホーム」(2-5 (2))・
 *      「連絡帳画面（保護者）」(2-6 (5))、基本設計書「写真の同意で止める規則」(4-2)、GitHub Issue #213（フォーカス）
 *
 * jsdom には画像を描く仕組み（createImageBitmap・canvas）が無いので、偽物に差し替えて「向きを直して 1600px・JPEG 0.85 に描き直す」を確かめる。
 * 画面はモック（api/mock.ts）が相手。時計は今日の 18:00。mockDb はこのファイルのテストで使い回す（同意を変えたら戻す）。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser, PhotoConsentLevel } from '../src/api/types';
import { api } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { MSG } from '../src/messages';
import { fitSize, photoProblem, redrawPhoto } from '../src/screens/contact/photoRedraw';
import { consentMark } from '../src/components/photoConsent';
import ContactPhotoImage from '../src/screens/contact/ContactPhotoImage';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組', is_temp_password: false, terms_agreed: true,
};
const taroGuardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
};
const misakiGuardian: SessionUser = {
  account_id: 9, email: 'miyagi.r@example.jp', role: '3', display_name: '宮城',
  staff_id: null, guardian_id: 'G004', class_id: null, class_name: null, is_temp_password: false, terms_agreed: true,
};

function open(path: string, user: SessionUser) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}><App /></SessionProvider>
    </MemoryRouter>,
  );
}
const toast = () => document.querySelector('.toast');
const jpegBytes = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const photoFile = (type = 'image/jpeg') => new File([jpegBytes()], 'IMG_0001.jpg', { type });

/** 画像を描く仕組みの偽物。読んだ写真は 4000×3000（横長）とする */
const drawn: { orientation?: string; width?: number; height?: number; type?: string; quality?: number; draws: number } = { draws: 0 };
beforeEach(() => {
  drawn.draws = 0;
  vi.stubGlobal('createImageBitmap', vi.fn(async (_file: Blob, options?: ImageBitmapOptions) => {
    drawn.orientation = options?.imageOrientation;
    return { width: 4000, height: 3000, close: () => undefined };
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { drawImage: () => { drawn.draws++; drawn.width = this.width; drawn.height = this.height; } } as unknown as RenderingContext;
  } as never);
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, type?: string, quality?: number) {
    drawn.type = type; drawn.quality = quality;
    cb(new Blob([jpegBytes()], { type: 'image/jpeg' }));
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 同意を変えて fn を回し、元へ戻す */
async function withConsent(levels: Record<string, PhotoConsentLevel>, fn: () => Promise<void>): Promise<void> {
  const before = Object.keys(levels).map((id) => [id, db.children.find((c) => c.child_id === id)!.photo_consent_level] as const);
  for (const [id, lv] of Object.entries(levels)) db.children.find((c) => c.child_id === id)!.photo_consent_level = lv;
  try { await fn(); } finally {
    for (const [id, lv] of before) db.children.find((c) => c.child_id === id)!.photo_consent_level = lv;
  }
}

/** 連絡帳（クラス）画面から「写真を送る」を開き、写真を選ぶ */
async function openSendFromClass(): Promise<HTMLElement> {
  open('/staff/contact', teacher);
  const opener = await screen.findByRole('button', { name: '写真を送る' }, { timeout: 3000 });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: '写真を送る' }, { timeout: 3000 });
  const input = await within(dialog).findByLabelText('写真を撮る・選ぶ（1枚）', undefined, { timeout: 3000 });
  fireEvent.change(input, { target: { files: [photoFile()] } });
  // 描き直した写真の見本が出る
  await within(dialog).findByRole('img', { name: '選んだ写真' }, { timeout: 3000 });
  return dialog;
}
const sendDialog = () => screen.getByRole('dialog', { name: '写真を送る' });
const pickerDialog = () => screen.getByRole('dialog', { name: '写っている子を選ぶ' });
const sendButton = () => within(sendDialog()).getByRole('button', { name: '送る' }) as HTMLButtonElement;

describe('写真を整える（詳細設計書 (2-2 (7)) の①）', () => {
  it('向きを付帯情報のとおりに直して読み、長い辺 1600px・JPEG（品質 0.85）に描き直す', async () => {
    const out = await redrawPhoto(photoFile());
    expect([drawn.orientation, drawn.width, drawn.height, drawn.type, drawn.quality, drawn.draws]).toEqual(['from-image', 1600, 1200, 'image/jpeg', 0.85, 1]);
    expect(out.type).toBe('image/jpeg');
    expect(fitSize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('JPEG・PNG 以外、10MB を超えるものは選べない', () => {
    expect(photoProblem(new Blob(['x'], { type: 'image/gif' }), 10)).toBe(MSG.photoFormat);
    expect(photoProblem(new Blob([new Uint8Array(2 * 1024 * 1024)], { type: 'image/jpeg' }), 1)).toBe(MSG.photoFormat);
    expect(photoProblem(new Blob(['x'], { type: 'image/png' }), 10)).toBeNull();
  });
});

describe('写真を送る（連絡帳（クラス）画面の「写真を送る」）', () => {
  it('写っている子を選ぶまで送れない。選び終えたら「写っている子を選ぶ」へ、閉じたら「写真を送る」へフォーカスが戻る', async () => {
    const dialog = await openSendFromClass();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '写っている子を選ぶ' }));
    const picker = pickerDialog();
    expect((within(picker).getByRole('button', { name: '決める' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(picker).getByText(MSG.photoSubjectRequired)).toBeTruthy();
    fireEvent.click(within(picker).getByRole('button', { name: '野原 太郎' }));
    fireEvent.click(within(picker).getByRole('button', { name: '決める' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('写っている子を選ぶ'));
    expect(sendDialog().textContent).toContain('写っている子：野原 太郎');
    // 宛先を大きく示す（園児名・クラス・届く続柄）
    expect(within(sendDialog()).getByRole('note', { name: '宛先' }).textContent).toContain('野原 太郎（さくら組）父に届きます');
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(within(sendDialog()).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('写真を送る'));
  });

  it('同意を満たさない子には「園内記録のみ」「ほかの家庭には出せない」を出し、送らせない', async () => {
    await withConsent({ C001: '1' }, async () => {
      const dialog = await openSendFromClass();
      fireEvent.click(within(dialog).getByRole('button', { name: '写っている子を選ぶ' }));
      fireEvent.click(within(pickerDialog()).getByRole('button', { name: '野原 太郎' }));
      expect(within(pickerDialog()).getByRole('button', { name: '野原 太郎（園内記録のみ）' }).textContent).toContain('園内記録のみ');
      // 2人目を選ぶと、同意 2 の子にも「ほかの家庭には出せない」
      fireEvent.click(within(pickerDialog()).getByRole('button', { name: '伊藤 葵' }));
      expect(within(pickerDialog()).getByRole('button', { name: '伊藤 葵（ほかの家庭には出せない）' })).toBeTruthy();
      fireEvent.click(within(pickerDialog()).getByRole('button', { name: '決める' }));
      await waitFor(() => expect(sendDialog().textContent)
        .toContain('野原 太郎さん・伊藤 葵さんは、ほかの保護者にも見える場への写真の同意がないため送れません。'));
      expect(sendButton().disabled).toBe(true);
    });
    expect([consentMark('1', 1), consentMark('2', 1), consentMark('2', 2), consentMark('3', 2)])
      .toEqual(['園内記録のみ', null, 'ほかの家庭には出せない', null]);
  });

  it('送ると「送りました。保護者が見られる状態です。」と出て、写っている子の連絡帳にだけ写真が出る', async () => {
    const before = db.contactPhotos.length;
    const dialog = await openSendFromClass();
    fireEvent.click(within(dialog).getByRole('button', { name: '写っている子を選ぶ' }));
    fireEvent.click(within(pickerDialog()).getByRole('button', { name: '野原 太郎' }));
    fireEvent.click(within(pickerDialog()).getByRole('button', { name: '決める' }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.change(within(sendDialog()).getByLabelText('添える文（なくても送れます）'), { target: { value: '砂場で型抜きをしました。' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さんへの写真：送りました。保護者が見られる状態です。'), { timeout: 3000 });
    expect(within(toast() as HTMLElement).getByRole('button', { name: '取り消す' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '写真を送る' })).toBeNull();
    expect(db.contactPhotos.length).toBe(before + 1);
    // 送ったのは描き直した写真（JPEG）
    expect(db.contactPhotos.at(-1)?.file_type).toBe('image/jpeg');
    const taro = await api.contactPage(taroGuardian, 'C001');
    expect(taro.events.some((e) => e.event_type === '5' && e.body === '砂場で型抜きをしました。')).toBe(true);
    const misaki = await api.contactPage(misakiGuardian, 'C004');
    expect(misaki.events.some((e) => e.event_type === '5')).toBe(false);
    // 表の「ひとこと・写真」に、その日の新しい写真が小さく出る
    await screen.findByRole('button', { name: /^野原 太郎の写真（\d\d:\d\d）を大きく見る$/ }, { timeout: 3000 });
  });

  it('子どもが写っていないときは、届ける子を1人選んで送れる', async () => {
    const dialog = await openSendFromClass();
    fireEvent.click(within(dialog).getByRole('button', { name: '写っている子を選ぶ' }));
    fireEvent.click(within(pickerDialog()).getByRole('button', { name: '子どもは写っていない' }));
    expect((within(pickerDialog()).getByRole('button', { name: '決める' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(pickerDialog()).getByRole('button', { name: '宮城 美咲に届ける' }));
    fireEvent.click(within(pickerDialog()).getByRole('button', { name: '決める' }));
    await waitFor(() => expect(sendDialog().textContent).toContain('子どもは写っていない（届ける子：宮城 美咲）'));
    fireEvent.click(sendButton());
    await waitFor(() => expect(toast()?.textContent).toContain('宮城 美咲さんへの写真：送りました。'), { timeout: 3000 });
    const page = await api.contactPage(misakiGuardian, 'C004');
    expect(page.events.some((e) => e.event_type === '5')).toBe(true);
  });

  it('添える文に他児の名前があれば注意を出す。「直す」で添える文の欄へ戻り、「このまま送る」で送れる', async () => {
    await withConsent({ C001: '3', C006: '3' }, async () => {
      const dialog = await openSendFromClass();
      fireEvent.click(within(dialog).getByRole('button', { name: '写っている子を選ぶ' }));
      fireEvent.click(within(pickerDialog()).getByRole('button', { name: '野原 太郎' }));
      fireEvent.click(within(pickerDialog()).getByRole('button', { name: '伊藤 葵' }));
      fireEvent.click(within(pickerDialog()).getByRole('button', { name: '決める' }));
      await waitFor(() => expect(sendButton().disabled).toBe(false));
      // 2人が写るとき、宛先は2家庭ぶん出す
      expect(within(sendDialog()).getAllByRole('note', { name: '宛先' })).toHaveLength(2);
      fireEvent.change(within(sendDialog()).getByLabelText('添える文（なくても送れます）'), { target: { value: 'たっくんがスコップで砂を運んでいました。' } });
      fireEvent.click(sendButton());
      const check = await screen.findByRole('dialog', { name: 'ほかのお子さんの名前の注意' }, { timeout: 3000 });
      expect(check.textContent).toContain('ほかのお子さんの名前（野原 太郎）が入っています。');
      expect(check.querySelector('mark')?.textContent).toBe('たっくん');
      fireEvent.click(within(check).getByRole('button', { name: '直す' }));
      await waitFor(() => expect(document.activeElement).toBe(within(sendDialog()).getByLabelText('添える文（なくても送れます）')));
      expect((document.activeElement as HTMLTextAreaElement).value).toBe('たっくんがスコップで砂を運んでいました。');
      fireEvent.click(sendButton());
      fireEvent.click(within(await screen.findByRole('dialog', { name: 'ほかのお子さんの名前の注意' }, { timeout: 3000 })).getByRole('button', { name: 'このまま送る' }));
      await waitFor(() => expect(toast()?.textContent).toContain('野原 太郎さん・伊藤 葵さんへの写真：送りました。'), { timeout: 3000 });
    });
  });

  it('JPEG・PNG 以外を選ぶと、その旨を出して送らせない', async () => {
    open('/staff/contact', teacher);
    fireEvent.click(await screen.findByRole('button', { name: '写真を送る' }, { timeout: 3000 }));
    const dialog = await screen.findByRole('dialog', { name: '写真を送る' }, { timeout: 3000 });
    fireEvent.change(await within(dialog).findByLabelText('写真を撮る・選ぶ（1枚）', undefined, { timeout: 3000 }),
      { target: { files: [new File(['GIF89a'], 'a.gif', { type: 'image/gif' })] } });
    expect((await within(dialog).findByRole('alert')).textContent).toBe(MSG.photoFormat);
    expect(sendButton().disabled).toBe(true);
  });
});

describe('連絡帳（園児）画面の「写真を送る」', () => {
  it('写っている子はこの子を選んだ状態で開く', async () => {
    open('/staff/contact/C001', teacher);
    await screen.findByRole('heading', { name: '野原 太郎' }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: '写真を送る' }));
    await waitFor(() => expect(sendDialog().textContent).toContain('写っている子：野原 太郎'), { timeout: 3000 });
  });
});

describe('写真の表示（詳細設計書 (2-5 (2))・(2-6 (5))）', () => {
  it('保護者の連絡帳とホームに写真が出る。押すと画面いっぱいに出し、閉じると押した写真へ戻る', async () => {
    const { photo } = await api.sendPhoto(teacher, { file: new Blob([jpegBytes()], { type: 'image/jpeg' }), subject_child_ids: ['C001'] });
    const url = await api.photoUrl(taroGuardian, photo.contact_photo_id);
    open('/guardian/contact/C001', taroGuardian);
    const buttons = await screen.findAllByRole('button', { name: /^\d\d:\d\d の写真を大きく見る$/ }, { timeout: 3000 });
    const mine = buttons.find((b) => b.querySelector('img')?.getAttribute('src') === url)!;
    expect(mine).toBeTruthy();
    mine.focus();
    fireEvent.click(mine);
    const viewer = await screen.findByRole('dialog', { name: /^\d\d:\d\d の写真$/ });
    expect(within(viewer).getByRole('img').getAttribute('src')).toBe(url);
    fireEvent.click(within(viewer).getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(document.activeElement).toBe(mine));
    cleanup();

    open('/guardian', taroGuardian);
    const thumb = await screen.findAllByRole('button', { name: /^\d\d:\d\d の写真を大きく見る$/ }, { timeout: 3000 });
    expect(thumb.some((b) => b.querySelector('img.contact-photo.is-thumb')?.getAttribute('src') === url)).toBe(true);
  });

  it('見られない写真は「この写真は開けません。」と出す（ほかの家庭・取り消した写真）', async () => {
    const { photo, events } = await api.sendPhoto(teacher, { file: new Blob([jpegBytes()], { type: 'image/jpeg' }), subject_child_ids: ['C001'] });
    render(<SessionProvider initialUser={misakiGuardian}><ContactPhotoImage photoId={photo.contact_photo_id} label="写真" size="thumb" /></SessionProvider>);
    expect(await screen.findByText(MSG.photoForbidden, undefined, { timeout: 3000 })).toBeTruthy();
    cleanup();
    await api.cancelEvent(teacher, events[0].contact_event_id);
    render(<SessionProvider initialUser={teacher}><ContactPhotoImage photoId={photo.contact_photo_id} label="写真" size="thumb" /></SessionProvider>);
    expect(await screen.findByText(MSG.photoForbidden, undefined, { timeout: 3000 })).toBeTruthy();
  });
});
