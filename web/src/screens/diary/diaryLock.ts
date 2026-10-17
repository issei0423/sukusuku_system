/*
 * 日誌の編集ロックの取得・解除（日誌作成・編集画面と日誌確認画面が使う）
 * 典拠：基本設計書.md「編集ロックの解除」(4-5)「保存・キャンセル・画面遷移でロックを解除する」
 *      「編集画面で一定時間（マスタ値）操作がない場合、自動で解除する」
 *
 * - ロックは、編集画面から確認画面へ引き継ぐ。確認画面へ移るときに外すと、確認画面にいる間にほかの職員が
 *   開いて直せてしまい、申請がその直しを黙って上書きする（GitHub Issue #166 の 1 の手順 B）。
 *   確認画面は、申請する（サーバが外す）か、画面を離れるときに外す。
 * - 解除は、取得のときに受け取った識別子を添えて送る。サーバは一致するときだけ外す。
 * - 取得と解除は、送った順にサーバへ届ける（前の要求の応答を待ってから次を送る）。開発時の StrictMode は、
 *   画面を描いた直後に後始末と描き直しをもう一度走らせるため、同じ日誌の取得・解除が続けて出る。
 *   前後すると、古い識別子でロックを上書きしたり、取り直したロックを外したりする。
 */
import { api } from '../../api/client';
import type { SessionUser } from '../../api/types';

/**
 * 【仮置き】編集画面での操作を、サーバへ知らせる間隔の下限（ミリ秒）。入力のたびには送らない。
 * 無操作の時間（設定マスタ `ui.diary_lock_minutes`、既定 15 分）より十分に短くする（web/仮置き値.md）
 */
export const LOCK_TOUCH_MS = 30_000;

let queue: Promise<unknown> = Promise.resolve();

function inOrder<T>(f: () => Promise<T>): Promise<T> {
  const p = queue.then(f, f);
  queue = p.catch(() => undefined);
  return p;
}

export const acquireDiaryLock = (user: SessionUser, diaryId: number) =>
  inOrder(() => api.acquireLock(user, diaryId));

export const releaseDiaryLock = (user: SessionUser, diaryId: number, token: string) =>
  inOrder(() => api.releaseLock(user, diaryId, false, token));

/** タブを閉じる・読み込み直すときの解除。順番を待たずに送る（待つと、送られないまま閉じる） */
export const releaseDiaryLockNow = (user: SessionUser, diaryId: number, token: string) =>
  api.releaseLock(user, diaryId, false, token);

/*
 * 画面を離れるときの解除を、描き直しの後まで遅らせて送る。同じ画面がすぐに同じロックを持ち直したら
 * （開発時の StrictMode の描き直し）取りやめる。日誌確認画面は、引き継いだ識別子を取り直せないため、
 * 後始末で外すと持ち直せなくなる
 */
const pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();

export function releaseDiaryLockLater(user: SessionUser, diaryId: number, token: string): void {
  const key = `${diaryId}:${token}`;
  pendingReleases.set(key, setTimeout(() => {
    pendingReleases.delete(key);
    void releaseDiaryLock(user, diaryId, token);
  }, 0));
}

export function keepDiaryLock(diaryId: number, token: string): void {
  const key = `${diaryId}:${token}`;
  const t = pendingReleases.get(key);
  if (t !== undefined) {
    clearTimeout(t);
    pendingReleases.delete(key);
  }
}
