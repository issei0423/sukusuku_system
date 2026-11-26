/*
 * 日誌の本文の見出しの行（「【」で始まり「】」で終わる行）を取り出す（AI の下書きに送る）
 * 典拠：詳細設計書「日誌の画面（作り直し）」(2-13 (7))・「保育日誌の下書き」(8-12)
 *
 * 見出しの名前（【】の中）だけを返す。0〜20個・1つ50文字まで（8-12）。空の見出し（「【】」）と50文字を超える行は見出しとして送らない。
 * 21個目からは送らない（サーバが 400 で断るため。画面の不具合でしか起きない誤りを、長い日誌で起こさない）。
 * 同じ見出しの重なりはサーバが1つにする
 */

/** 見出しの数と長さの上限（server/api_ai_diary.go の aiDiaryHeadingsMax・aiDiaryHeadingMax） */
const HEADINGS_MAX = 20;
const HEADING_MAX = 50;

/** 本文の行が見出しの行なら、その名前（【】の中）を返す。見出しの行でなければ null */
function headingOf(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith('【') || !t.endsWith('】')) return null;
  return t.slice(1, -1).trim();
}

/** 本文の中の見出しの名前を、現れた順に返す */
export function diaryHeadings(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const h = headingOf(line);
    if (h && [...h].length <= HEADING_MAX && out.length < HEADINGS_MAX) out.push(h);
  }
  return out;
}

/**
 * 本文に、見出しの行でも空の行でもない行（文）があるか。
 * 【仮置き】雛形を呼び出しただけ（見出しの行だけ）の本文は「文が無い」と読み、AI の下書きをそのまま入れる。文があれば置き換えずに候補で示す
 * （詳細設計書 (2-13 (7)) は「本文が空なら入れ、文があれば候補」。web/仮置き値.md）
 */
export function hasDiarySentence(body: string): boolean {
  return body.split('\n').some((line) => line.trim() !== '' && headingOf(line) === null);
}
