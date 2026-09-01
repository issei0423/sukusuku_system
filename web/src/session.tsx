/*
 * ログイン状態の保持
 *
 * 認証情報の保持方式は未確定である（要決定事項.md 優先度A）。
 * モックではメモリ上にのみ保持し、再読み込みでログアウトする。
 * Cookie / localStorage のどちらを採るかは Go サーバの実装時に決める。
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { SessionUser } from './api/types';
import { api } from './api/client';

interface SessionValue {
  user: SessionUser | null;
  /** 開いた入口。ログアウトの遷移先はログインしていた系統のトップ（基本設計書「画面遷移」(3-4)） */
  entrance: 'staff' | 'guardian';
  setUser: (u: SessionUser | null) => void;
  setEntrance: (e: 'staff' | 'guardian') => void;
  logout: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children, initialUser = null }: { children: ReactNode; initialUser?: SessionUser | null }) {
  const [user, setUser] = useState<SessionUser | null>(initialUser);
  const [entrance, setEntrance] = useState<'staff' | 'guardian'>('staff');

  // サーバ側のセッションと参照表も捨てる。共有端末で前の利用者の情報を残さないため
  const logout = () => {
    setUser(null);
    void api.logout();
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
