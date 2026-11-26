/*
 * 演習用：合言葉つきの URL での入口（/demo-login?k=合言葉）
 *
 * 【仮置き】設計書に定めが無い。公開先のデモで、持ち主がログインID・パスワードを打たずに西田 拓也として
 * 入るための入口であり、実装（本番）では持たない（web/仮置き値.md）。
 *
 * - 合言葉の判定と、入るアカウントの選び分けは、サーバだけが行う（server/api_demo_login.go。環境変数
 *   SUKUSUKU_DEMO_LOGIN_KEY を置いたときだけ働く）。この画面は URL の k を読んでサーバへ送るだけで、
 *   合言葉も、デモのログインID・パスワードも持たない（build/keepMockOutOfBuild.ts の見張りに触れない）。
 * - k は読んだらすぐ history.replaceState で URL から消す。画面にも出さず、履歴にも残さない。
 *   消すのは、画面の状態（メモリ）へ移したあと。StrictMode で効果が2回走っても、2回目に k が無いからと
 *   メモリの値を消さない。
 * - モック（VITE_API=mock・npm run dev:mock）では使えない。合言葉の照合をブラウザに持たせると
 *   だれでも読めてしまうため、モックには持たせず、業務の規則でもないので Go サーバと同じ規則も作らない
 *   （api/mock.ts の demoLogin）。「この環境では使えません」とだけ出す。
 * - 入れないときは、理由を分けず「このURLでは入れません」とだけ出す（k が無い・違う・機能が無いを悟らせない）。
 * - ログイン中に開いたら、新しいセッションは作らず、いまのホームへ送る（サーバも同じく断る）。
 */
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import PublicLayout from '../../layouts/PublicLayout';
import { Alert } from '../../components/ui';
import { useSession } from '../../session';
import { api, backend } from '../../api/client';
import { LoginIcon } from '../../components/icons';

/** 入れないときの文。理由は分けない */
export const DEMO_LOGIN_REFUSED = 'このURLでは入れません';
/** モックのときの文 */
export const DEMO_LOGIN_UNAVAILABLE = 'この環境では使えません';

export default function DemoLoginScreen() {
  const { user, setUser, setEntrance } = useSession();
  const navigate = useNavigate();
  // undefined：まだ URL を読んでいない。null：k が無い（または入れないと分かった）
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  // この画面でログインした直後は、いまのホームへ送る処理を働かせない（下の navigate が、手続きの画面を含めて行き先を決める）
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('k')) {
      setKey((prev) => (prev === undefined ? null : prev));
      return;
    }
    const k = params.get('k');
    setKey(k ? k : null);
    // 合言葉を URL から消す。ルータが history.state に持つ値（遷移の印）は、そのまま残す
    params.delete('k');
    const rest = params.toString();
    window.history.replaceState(window.history.state, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  }, []);

  if (backend === 'mock') {
    return (
      <PublicLayout>
        <h1 className="public-title">デモ用の入口</h1>
        <p>{DEMO_LOGIN_UNAVAILABLE}</p>
      </PublicLayout>
    );
  }
  if (user && !entered) return <Navigate to={user.role === '3' ? '/guardian' : '/staff'} replace />;
  if (key === undefined) return null;

  const enter = async (as: 'staff' | 'guardian') => {
    if (!key) return;
    setBusy(true);
    try {
      const u = await api.demoLogin(key, as);
      setEntered(true);
      setEntrance(as);
      setUser(u);
      // 一時パスワード中と規約の再同意が必要なときは、完了するまで他の画面へ進めない（TopScreen と同じ）
      if (u.is_temp_password) navigate('/password-change');
      else if (!u.terms_agreed) navigate('/terms-agree');
      else navigate(u.role === '3' ? '/guardian' : '/staff');
    } catch {
      setKey(null);
      setRefused(true);
      setBusy(false);
    }
  };

  return (
    <PublicLayout>
      <h1 className="public-title">デモ用の入口</h1>
      {key === null || refused ? (
        <Alert>{DEMO_LOGIN_REFUSED}</Alert>
      ) : (
        <div className="stack">
          <button className="btn-primary btn-block" type="button" disabled={busy} onClick={() => { void enter('staff'); }}>
            <LoginIcon />保育士として入る
          </button>
          <button className="btn-block" type="button" disabled={busy} onClick={() => { void enter('guardian'); }}>
            <LoginIcon />保護者として入る
          </button>
        </div>
      )}
    </PublicLayout>
  );
}
