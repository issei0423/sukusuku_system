/*
 * 保存していない入力
 *
 * ログアウトの前に、保存していない入力があるかを確かめる。あれば、破棄される旨を表示して確認する
 * （基本設計書「ログアウト」(4-3)。GitHub Issue #170）。
 *
 * 入力を持つ画面が useUnsavedInput で「いま保存していない入力がある」ことを知らせ、
 * ログアウトを置くレイアウトが useUnsavedInputTracker で受け取って、ログアウトの前に確かめる
 * （レイアウトは report を UnsavedInputContext.Provider で画面へ渡す）。
 * 画面ごとに確認の作りを持たせず、ログアウトの側の1か所で確かめるため。
 * 受け取る側が無い（Provider の外の）画面では、何もしない。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type Report = (key: symbol, unsaved: boolean) => void;

export const UnsavedInputContext = createContext<Report | null>(null);

/** レイアウトが持つ。report を UnsavedInputContext.Provider で渡し、ログアウトの前に hasUnsavedInput() で確かめる */
export function useUnsavedInputTracker(): { report: Report; hasUnsavedInput: () => boolean } {
  const unsaved = useRef(new Set<symbol>());
  const report = useCallback<Report>((key, value) => {
    if (value) unsaved.current.add(key);
    else unsaved.current.delete(key);
  }, []);
  const hasUnsavedInput = useCallback(() => unsaved.current.size > 0, []);
  return { report, hasUnsavedInput };
}

/**
 * 保存していない入力があるかを、ログアウトを置くレイアウトへ知らせる。
 * 画面を離れたら（アンマウントしたら）知らせを取り下げる
 */
export function useUnsavedInput(unsaved: boolean): void {
  const report = useContext(UnsavedInputContext);
  const [key] = useState(() => Symbol('unsaved-input'));
  useEffect(() => {
    if (!report) return;
    report(key, unsaved);
    return () => report(key, false);
  }, [report, key, unsaved]);
}
