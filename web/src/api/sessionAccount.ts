/*
 * 画面が思っている利用者（ログイン中の account_id）
 *
 * ログインの Cookie は同じブラウザのタブすべてで共有される。あるタブを開いたまま、別のタブでログアウトして
 * 別のアカウントでログインし直すと、開いたままのタブは画面の上では前の利用者なのに、要求は新しいアカウントの
 * Cookie で届く。保護者の画面から送ったメッセージが職員の送信として残り、自分の送信を編集・取消できなくなっていた。
 *
 * 画面は要求のたびに、ここに持つ account_id をサーバへ添える（api/http.ts。server/session.go の accountHeader）。
 * サーバはセッションの利用者と違えば何もせず 409（account_changed）を返し、画面（App.tsx）はセッションを
 * 読み直して、いまのアカウントの画面へ切り替える。
 * 値は session.tsx の setUser が、画面の利用者と同時に入れ替える。描画を待たずに入れ替えるのは、
 * 切り替えた直後の画面が最初に送る要求にも、新しい利用者を添えるため。
 * 【仮置き】設計はこの場面を決めていない（web/仮置き値.md）
 */

/** 要求に添えるヘッダの名前（server/session.go の accountHeader） */
export const ACCOUNT_HEADER = 'X-Sukusuku-Account';
/** ヘッダを付けられない知らせの接続（EventSource）で使うクエリの名前（server/session.go の accountQuery） */
export const ACCOUNT_QUERY = '_account';
/** サーバが食い違いを知らせる理由（server/session.go の kindAccountChanged） */
export const ACCOUNT_CHANGED_KIND = 'account_changed';

let current: number | null = null;

export function setSessionAccount(accountId: number | null): void {
  current = accountId;
}

export function sessionAccount(): number | null {
  return current;
}

const accountChangedListeners = new Set<() => void>();

/** 食い違いの知らせを受け取る（App.tsx）。戻り値を呼ぶと受け取りをやめる */
export function onAccountChanged(listener: () => void): () => void {
  accountChangedListeners.add(listener);
  return () => { accountChangedListeners.delete(listener); };
}

export function notifyAccountChanged(): void {
  accountChangedListeners.forEach((l) => l());
}
