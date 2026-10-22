/*
 * 「家庭から」の届いた園児が増えたことを見つけ、読み上げる文を作る（読み上げへ伝える欄 HomeArrival.tsx に渡す）
 * 典拠：詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)「読み上げの範囲」の②（決めたこと D-57）、
 *      WCAG 4.1.3 ステータスメッセージ、GitHub Issue #209
 *
 * 読み直すたびには読まず、「家庭から」のある園児が増えたときだけ文を作る。
 * 開いたとき・クラスや日付を替えたときは、そのときの状態を起点にして読まない。送り直し（「更新」）は数が増えないので読まない。
 */
import { useEffect, useRef, useState } from 'react';

/** 「家庭から」が届いている園児（園児ID と氏名） */
export type HomeArrived = { id: string; name: string };

/**
 * 2人以上がまとめて届いたときは「家庭からが2件届きました（〇〇さん、△△さん）」。
 * 1件の形は詳細設計書 (2-0) の (6) の文。2件以上の形は【仮置き】（web/仮置き値.md）
 */
export function homeArrivedText(names: string[]): string {
  return `家庭からが${names.length}件届きました（${names.map((n) => `${n}さん`).join('、')}）`;
}

/**
 * scope は、いま見ている範囲（クラスと日付、または園児と日付）。応答が持つ値で作り、読み込み中の前の応答と取り違えない。
 * arrived は、その範囲で家庭からが届いている園児。読み込みが済むまでは null を渡す
 */
export function useHomeArrival(scope: string | null, arrived: HomeArrived[] | null) {
  const prev = useRef<{ scope: string; ids: Set<string> } | null>(null);
  const [said, setSaid] = useState<{ scope: string; text: string; seq: number } | null>(null);
  const key = arrived ? arrived.map((a) => a.id).sort().join('\n') : null;
  const latest = useRef(arrived);
  useEffect(() => { latest.current = arrived; });
  useEffect(() => {
    const list = latest.current;
    if (scope === null || key === null || !list) return;
    const before = prev.current;
    prev.current = { scope, ids: new Set(list.map((a) => a.id)) };
    if (!before || before.scope !== scope) return;
    const added = list.filter((a) => !before.ids.has(a.id));
    if (added.length === 0) return;
    setSaid((s) => ({ scope, text: homeArrivedText(added.map((a) => a.name)), seq: (s?.seq ?? 0) + 1 }));
  }, [scope, key]);
  return said && said.scope === scope ? said : null;
}
