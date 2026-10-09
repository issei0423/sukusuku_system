/*
 * 職員用トップ／保護者用トップ
 * 典拠：図/画面詳細図.md「職員用トップ／保護者用トップ」(2-1)・「ログイン中に入口を開いたとき」(2-2)
 *
 * 職員用と保護者用は同じ様式で、入口だけが異なる。
 * 新規登録の導線は保護者用トップにのみ置く（職員アカウントは管理者が発行するため）。
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PublicLayout from '../../layouts/PublicLayout';
import { Field, Alert } from '../../components/ui';
import { useSession } from '../../session';
import { api } from '../../api/client';
import type { LoginError } from '../../api/client';

export default function TopScreen({ entrance }: { entrance: 'staff' | 'guardian' }) {
  const { user, setUser, setEntrance, logout } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * ログイン中はログインフォームを表示しない。
   * 系統・アカウントを問わず新しいログインを成立させないため（要件定義書「同時ログインの扱い」(4-1-1)）。
   * 案内にログイン中の氏名・ロールを出さない。共有端末で前の利用者を第三者に示さないため。
   */
  if (user) {
    return (
      <PublicLayout>
        <h1>ログイン中</h1>
        <p>すでにログインしています。</p>
        <p>別のアカウントでログインするには、先にログアウトしてください。</p>
        <div className="stack">
          <button className="btn-primary btn-block" onClick={() => void logout()}>ログアウトする</button>
          <button className="btn-block" onClick={() => navigate(-1)}>前の画面へ戻る</button>
        </div>
      </PublicLayout>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await api.login(email, password, entrance);
      setEntrance(entrance);
      setUser(u);
      // 一時パスワード中と規約の再同意が必要なときは、完了するまで他の画面へ進めない（基本設計書 3-4）
      if (u.is_temp_password) navigate('/password-change');
      else if (!u.terms_agreed) navigate('/terms-agree');
      else navigate(u.role === '3' ? '/guardian' : '/staff');
    } catch (err) {
      try { setError(JSON.parse((err as Error).message) as LoginError); }
      catch { setError({ kind: 'credential', remaining: 0 }); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout>
      <h1 className="muted" style={{ textAlign: 'center', marginTop: -16, marginBottom: 16, fontSize: 20 }}>
        {entrance === 'staff' ? '職員用の入口' : '保護者用の入口'}
      </h1>

      <form className="stack" onSubmit={submit}>
        <Field label="ログインID" required>
          <input type="email" value={email} autoComplete="username"
            placeholder="example@hoiku.example.jp"
            onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="パスワード" required>
          <input type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <label>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          ログイン状態を保持する
        </label>

        {error && <LoginErrorView error={error} entrance={entrance} />}

        <button className="btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'ログインしています…' : 'ログイン'}
        </button>
      </form>

      {/* 新規登録の導線は保護者用トップにのみ置く（画面詳細図 2-1） */}
      {entrance === 'guardian' && (
        <div className="row" style={{ marginTop: 20, justifyContent: 'space-between' }}>
          <span className="muted">はじめての方</span>
          <Link className="btn" to="/signup">招待コードで新規登録</Link>
        </div>
      )}

      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <Link className="btn btn-quiet btn-sm" to={entrance === 'staff' ? '/' : '/staff-top'}>
          {entrance === 'staff' ? '保護者の方はこちら' : '職員の方はこちら'}
        </Link>
      </div>

      <DemoAccounts entrance={entrance} onPick={(m) => { setEmail(m); setPassword('pass1234'); }} />
    </PublicLayout>
  );
}

/** 誤った系統でのログインは成立させず、正しい入口を案内する（画面詳細図 2-1） */
function LoginErrorView({ error, entrance }: { error: LoginError; entrance: 'staff' | 'guardian' }) {
  if (error.kind === 'wrong_entrance') {
    return (
      <Alert>
        このアカウントは{entrance === 'staff' ? '保護者用' : '職員用'}の入口からログインしてください。
        {' '}
        <Link to={error.correct === 'staff' ? '/staff-top' : '/'}>
          {error.correct === 'staff' ? '職員用トップへ' : '保護者用トップへ'}
        </Link>
      </Alert>
    );
  }
  if (error.kind === 'locked') {
    return <Alert>ログインを一定回数以上まちがえたため、アカウントをロックしました。園の管理者へご連絡ください。</Alert>;
  }
  if (error.kind === 'suspended') {
    return <Alert>このアカウントは停止されています。園の管理者へご連絡ください。</Alert>;
  }
  return <Alert>ログインIDまたはパスワードが違います（残り {error.remaining} 回）</Alert>;
}

/**
 * 演習用の入口。実装では持たない。
 * デモの場で「どのアカウントで何が見えるか」を切り替えるために置いている
 */
function DemoAccounts({ entrance, onPick }: { entrance: 'staff' | 'guardian'; onPick: (email: string) => void }) {
  const staffList = [
    { email: 'nohara@hoiku.example.jp', label: '野原 一誠（管理者・園長）' },
    { email: 'takanashi@hoiku.example.jp', label: '高梨 倫太朗（一般・さくら組）' },
    { email: 'kinjo@hoiku.example.jp', label: '金城 宗一郎（一般・ひまわり組）' },
    { email: 'miyagi@hoiku.example.jp', label: '宮城 蓮（一時パスワード中）' },
  ];
  const guardianList = [
    { email: 'nohara.i@example.jp', label: '野原 一誠（野原 太郎の保護者）' },
    { email: 'uezono.k@example.jp', label: '上園 謙心（規約の再同意が必要）' },
    { email: 'takanashi.r@example.jp', label: '高梨 倫太朗（停止中のアカウント）' },
    { email: 'miyagi.r@example.jp', label: '宮城 蓮（宮城 美咲の保護者）' },
    { email: 'kinjo.s@example.jp', label: '金城 宗一郎（金城 陸の保護者）' },
  ];
  const list = entrance === 'staff' ? staffList : guardianList;

  return (
    <details style={{ marginTop: 20 }}>
      <summary className="muted" style={{ cursor: 'pointer' }}>演習用：デモアカウント</summary>
      <div className="stack" style={{ marginTop: 8 }}>
        {list.map((a) => (
          <button key={a.email} className="btn-sm" onClick={() => onPick(a.email)}>{a.label}</button>
        ))}
        <div className="muted">
          パスワードはいずれも pass1234。宮城 蓮のみ一時パスワード temp0901。
        </div>
      </div>
    </details>
  );
}
