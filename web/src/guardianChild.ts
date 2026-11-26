/*
 * 保護者の画面で「いま見ているお子さま」
 * 典拠：2026-11-26 に持ち主が頼んだ保護者の画面の作り直し（下のタブ「連絡帳」「成長」は園児ごとの道なので、
 * ホームで選んでいる園児へ行く）。図/画面詳細図「保護者ホーム」(2-7) の「お子さまが複数のとき」は、縦に全部積まず切り替える。
 *
 * 選んだ園児は GuardianLayout が持ち、画面をまたいで保つ（sessionStorage。タブを閉じると忘れる）。
 * 連絡帳・成長の記録の画面を園児の ID つきで開いたときは、その園児を選んだことにする。
 * 【仮置き】保存先は sessionStorage にした（web/仮置き値.md「保護者の画面の見た目」）
 */
import { createContext, useContext } from 'react';

export interface GuardianChildState {
  /** いま見ている園児の ID（園児が読み込まれるまでは null） */
  childId: string | null;
  setChildId: (childId: string) => void;
  /** ホームが数えた「新しく n 件」。下のタブの「連絡帳」に添える（ホームを開いている間だけ使う） */
  reportContactNew: (childId: string, count: number) => void;
}

export const GuardianChildContext = createContext<GuardianChildState>({
  childId: null,
  setChildId: () => undefined,
  reportContactNew: () => undefined,
});

export function useGuardianChild(): GuardianChildState {
  return useContext(GuardianChildContext);
}

const KEY = 'guardian.child';

/** 前に選んだ園児（アカウントごと）。読めない環境では null */
export function readSelectedChild(accountId: number | undefined): string | null {
  try {
    return window.sessionStorage.getItem(`${KEY}.${accountId ?? 0}`);
  } catch {
    return null;
  }
}

export function writeSelectedChild(accountId: number | undefined, childId: string): void {
  try {
    window.sessionStorage.setItem(`${KEY}.${accountId ?? 0}`, childId);
  } catch {
    // 保存できなくても、画面の中では選んだまま動く
  }
}
