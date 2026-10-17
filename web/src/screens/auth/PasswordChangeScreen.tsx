/*
 * パスワード変更画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)・「画面遷移」(3-4)
 *
 * 一時パスワードでのログイン後は、変更を完了するまで他の画面へ進めない。
 * 任意の変更時はメニューから開く。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout from '../../layouts/PublicLayout';
import { Field, Alert } from '../../components/ui';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { useUnsavedInput } from '../../unsavedInput';

export default function PasswordChangeScreen({ forced }: { forced?: boolean }) {
  const { user, setUser } = useSession();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  // 変更する前の入力は、ログアウトの前に確かめる（基本設計書「ログアウト」(4-3)。GitHub Issue #170）
  useUnsavedInput(!done && (current !== '' || next !== '' || next2 !== ''));

  if (!user) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== next2) { setError('新しいパスワードが一致しません'); return; }
    setBusy(true);
    try {
      await api.changePassword(user.account_id, current, next);
      const u = await api.reloadSession(user.account_id);
      setUser(u);
      setDone(true);
      if (forced) {
        // 規約の再同意が残っていればそちらへ、なければ各ロールのホームへ
        if (!u.terms_agreed) navigate('/terms-agree');
        else navigate(u.role === '3' ? '/guardian' : '/staff');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <form className="stack" onSubmit={submit}>
      {forced && (
        <Alert>
          一時パスワードでログインしています。パスワードを変更するまで、ほかの機能は利用できません。
        </Alert>
      )}
      {done && !forced && <Alert soft>パスワードを変更しました。</Alert>}
      {error && <Alert>{error}</Alert>}

      <Field label="現在のパスワード" required>
        <input type="password" value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="新しいパスワード" required>
        <input type="password" value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="新しいパスワード（確認）" required>
        <input type="password" value={next2} autoComplete="new-password" onChange={(e) => setNext2(e.target.value)} />
      </Field>
      {/* 8〜128文字。文字種の組み合わせは求めない（基本設計書「入力項目の制約値」(4-9)）。
          よく使われるパスワードは拒否する（同「パスワードの要件」(6-3)。GitHub Issue #159） */}
      <div className="muted">8〜128文字で入力してください。文字の種類の組み合わせは問いません。よく使われるパスワード（password など）は使えません。</div>
      <button className="btn-primary btn-block" type="submit" disabled={busy}>変更する</button>
    </form>
  );

  // 強制変更のときは入口の様式で全画面に出す。他の画面へ進ませないため
  if (forced) return <PublicLayout><h1 style={{ marginBottom: 16 }}>パスワードの変更</h1>{body}</PublicLayout>;

  return (
    <div style={{ maxWidth: 480 }}>
      <div className="page-head"><h1>パスワードの変更</h1></div>
      <section className="card">{body}</section>
    </div>
  );
}
