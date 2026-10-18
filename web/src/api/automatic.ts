/*
 * 裏の読み直しの印（GitHub Issue #210）
 * 典拠：基本設計書.md「ログイン」(4-3)「自動ログアウトは職員の画面に限る。最後の操作から時間を数える」、
 *      「リアルタイムの反映と通知」(4-10)「知らせの受け取りは、職員の自動ログアウトの『操作』に数えない」
 *
 * 開いたままの画面が裏で読み直す要求（hooks.ts の useAsync の background。GitHub Issue #150 の5秒ごとの読み直し）は、
 * 利用者の操作ではない。asAutomatic の中で始めた要求に、api/http.ts が印の見出しを付けて送り、
 * サーバ（server/session.go の countsAsOperation）はその要求では期限を延ばさない。
 *
 * 印が付くのは、asAutomatic に渡した関数が**その場で（await の前に）始めた要求**だけである。
 * 読み直しの関数は api の関数を1つ呼ぶ形にしておく。await のあとに始めた要求には印が付かず、操作に数えられる
 * （切れるのが遅れる側に倒れる）。
 *
 * 期限の判定はサーバが行う（基本設計書「権限チェックの実装方針」(6-2)）。印は「延ばさない」ことにだけ使い、
 * 権限には関わらない。モック（api/mock.ts）にはセッションの期限が無いため、印を受ける形は要らない。
 */

/** 【仮置き】印の見出しの名前。設計に無い（web/仮置き値.md）。サーバの autoRefreshHeader と同じにしてある */
export const AUTO_REFRESH_HEADER = 'X-Sukusuku-Auto-Refresh';

let depth = 0;

/** fn をその場で呼ぶ。その間に始めた要求を「裏の読み直し」として送る */
export function asAutomatic<T>(fn: () => T): T {
  depth += 1;
  try {
    return fn();
  } finally {
    depth -= 1;
  }
}

/** いま始める要求が、裏の読み直しか */
export function isAutomatic(): boolean {
  return depth > 0;
}
