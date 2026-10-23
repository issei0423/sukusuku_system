/*
 * ログイン状態の保持
 *
 * 認証情報の保持方式は未確定である（要決定事項.md 優先度A）。
 * モックではメモリ上にのみ保持し、再読み込みでログアウトする。
 * Cookie / localStorage のどちらを採るかは Go サーバの実装時に決める。
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { SessionUser } from './api/types';
import { api } from './api/client';
import { setSessionAccount } from './api/sessionAccount';

interface SessionValue {
  user: SessionUser | null;
  /** 開いた入口。ログアウトの遷移先はログインしていた系統のトップ（基本設計書「画面遷移」(3-4)） */
  entrance: 'staff' | 'guardian';
  setUser: (u: SessionUser | null) => void;
  setEntrance: (e: 'staff' | 'guardian') => void;
  /** サーバ側のセッションの破棄を待って解決する。画面遷移の前に必ず待つこと */
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children, initialUser = null }: { children: ReactNode; initialUser?: SessionUser | null }) {
  const [user, setUserState] = useState<SessionUser | null>(() => {
    setSessionAccount(initialUser?.account_id ?? null);
    return initialUser;
  });
  /*
   * 画面の利用者と、要求に添える利用者（api/sessionAccount.ts）を同時に入れ替える。
   * 描画を待ってから入れ替えると、切り替えた直後の画面が最初に送る要求に前の利用者が付き、サーバに止められる
   */
  const setUser = useCallback((u: SessionUser | null) => {
    setSessionAccount(u?.account_id ?? null);
    setUserState(u);
  }, []);
  const [entrance, setEntrance] = useState<'staff' | 'guardian'>('staff');

  /*
   * ログアウト
   *
   * サーバ側のセッションと参照表も捨てる。共有端末で前の利用者の情報を残さないため
   * （基本設計書「画面基本構成」(3-5)）。
   *
   * 破棄の完了を待ってから解決する。待たずに画面を遷移すると、
   * 全画面の読み込みで通信が打ち切られ、サーバ側のセッションが生き残る。
   * その状態で再読み込みすると前の利用者としてログインし直ってしまう。
   */
  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  };

  return <Ctx.Provider value={{ user, entrance, setUser, setEntrance, logout }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider の外で useSession が呼ばれました');
  return v;
}

/** ログイン必須の画面で使う。未ログインなら例外を投げず null を返す側で判定する */
export function useUser(): SessionUser {
  const { user } = useSession();
  if (!user) throw new Error('ログインしていません');
  return user;
}
