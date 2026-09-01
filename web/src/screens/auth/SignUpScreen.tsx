/*
 * 新規登録画面（保護者）
 * 典拠：図/画面詳細図.md「新規登録画面（保護者）」(2-3)
 *
 * 段階を1画面の中で上から順に踏ませる。招待コードが確認できるまで (2)(3) を操作できない。
 * 園児名を画面に表示しない。招待コードだけでは誰の保護者かを名乗る前の段階であるため。
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PublicLayout from '../../layouts/PublicLayout';
import { Field, Alert } from '../../components/ui';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';

export default function SignUpScreen() {
  const navigate = useNavigate();
  const { setUser, setEntrance } = useSession();
  const terms = useAsync(() => api.currentTerms(), []);

  const [code, setCode] = useState('');
  const [codeOk, setCodeOk] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('母');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verify = async () => {
    setError(null);
    try {
      await api.verifyInvitationCode(code);
      setCodeOk(true);
    } catch (e) {
      setCodeOk(false);
      setError((e as Error).message);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== password2) { setError('パスワードが一致しません'); return; }
    setBusy(true);
    try {
      const u = await api.signUpGuardian({ code, email, password, guardian_name: name, relationship });
      setEntrance('guardian');
      setUser(u);
      navigate('/guardian');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicLayout wide>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/">&lt; 戻る</Link>
        <h1>新規登録</h1>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      {/* (1) 招待コードの入力 */}
      <div className="step">
        <div className="step-title">(1) 招待コードの入力</div>
        <div className="row">
          <Field label="招待コード" required style={{ flex: 1 }}>
            <input type="text" value={code} placeholder="ABCD-1234-EFGH"
              onChange={(e) => { setCode(e.target.value); setCodeOk(false); }} />
          </Field>
          <button onClick={verify} disabled={!code.trim()}>コードを確認する</button>
        </div>
        {codeOk && <div className="muted" style={{ marginTop: 8 }}>招待コードを確認しました。次へ進んでください。</div>}
        {/*
          【要確認】招待コードの入力形式（区切りの有無・大文字小文字の扱い）は
          基本設計書「メッセージ一覧」(4-9) と合わせて決める（画面詳細図 2-3）。
          モックでは大文字に正規化して照合している。
        */}
      </div>

      {/* (2) 利用規約への同意 */}
      <div className={`step${codeOk ? '' : ' locked'}`}>
        <div className="step-title">(2) 利用規約への同意</div>
        <div className="terms-box">{terms.data?.body ?? '読み込んでいます…'}</div>
        <label style={{ marginTop: 8 }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          利用規約に同意します
        </label>
      </div>

      {/* (3) アカウント情報 */}
      <form className={`step${codeOk && agreed ? '' : ' locked'}`} onSubmit={submit}>
        <div className="step-title">(3) アカウント情報</div>
        <div className="stack">
          <Field label="保護者の氏名" required>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="続柄" required>
            <select value={relationship} onChange={(e) => setRelationship(e.target.value)}>
              <option>母</option><option>父</option><option>祖母</option><option>祖父</option><option>その他</option>
            </select>
          </Field>
          <Field label="メールアドレス" required>
            <input type="email" value={email} autoComplete="username" onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="パスワード" required>
            <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="パスワード（確認）" required>
            <input type="password" value={password2} autoComplete="new-password" onChange={(e) => setPassword2(e.target.value)} />
          </Field>
          <button className="btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? '登録しています…' : '登録する'}
          </button>
        </div>
      </form>
    </PublicLayout>
  );
}
