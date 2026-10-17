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
import { validateEmail, validateNewPassword } from '../../api/util';
import { LoggedInNotice } from './TopScreen';

export default function SignUpScreen() {
  const navigate = useNavigate();
  const { user, setUser, setEntrance } = useSession();
  const terms = useAsync(() => api.currentTerms(), []);
  // ログインより前に開いておいたタブから送り、サーバに断られたとき（下の submit）
  const [loggedInElsewhere, setLoggedInElsewhere] = useState(false);

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
    if (!codeOk || !agreed) { setError('招待コードの確認と利用規約への同意を済ませてください'); return; }
    // 送る前に画面でも確かめる。検査の担保はサーバ側が行う（基本設計書「入力項目の制約値」(4-9)）
    if (!name.trim()) { setError('保護者の氏名を入力してください'); return; }
    const emailError = validateEmail(email);
    if (emailError) { setError(emailError); return; }
    // 8〜128文字（文字数で数える）。よく使われるパスワードは使えない（基本設計書 4-9・6-3。GitHub Issue #159）
    const passwordError = validateNewPassword(password);
    if (passwordError) { setError(passwordError); return; }
    if (password !== password2) { setError('パスワードが一致しません'); return; }
    setBusy(true);
    try {
      const u = await api.signUpGuardian({ code, email, password, guardian_name: name, relationship });
      setEntrance('guardian');
      setUser(u);
      navigate('/guardian');
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('"already_logged_in"')) setLoggedInElsewhere(true);
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * ログイン中は登録の入力欄を出さない。登録が成立するとセッションが新しい保護者に置き換わり、
   * 上書きログインと同じことになる（基本設計書「ログイン」(4-3)、画面詳細図 2-2。GitHub Issue #159）。
   * 担保はサーバ側（server/api_auth.go の handleSignUpGuardian）が行う
   */
  if (user || loggedInElsewhere) return <LoggedInNotice onLoggedOut={() => setLoggedInElsewhere(false)} />;

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
        {codeOk && <div className="muted" role="status" style={{ marginTop: 8 }}>招待コードを確認しました。次へ進んでください。</div>}
        <div className="muted" style={{ marginTop: 8 }}>
          大文字・小文字はどちらでも構いません。ハイフン（-）は入れても省いても確認できます。
        </div>
        {/* 入力形式は基本設計書「招待コード（t_invitation_code）」(5-2) による。打ち方の違いで失敗させない */}
      </div>

      {/* (2) 利用規約への同意 */}
      <div className={`step${codeOk ? '' : ' locked'}`} aria-disabled={!codeOk}>
        <div className="step-title">(2) 利用規約への同意</div>
        <div className="terms-box" tabIndex={0} aria-label="利用規約の本文">{terms.data?.body ?? '読み込んでいます…'}</div>
        <fieldset disabled={!codeOk}>
          <label style={{ marginTop: 8 }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            利用規約に同意します
          </label>
        </fieldset>
      </div>

      {/* (3) アカウント情報 */}
      <form className={`step${codeOk && agreed ? '' : ' locked'}`} aria-disabled={!codeOk || !agreed} onSubmit={submit}>
        <div className="step-title">(3) アカウント情報</div>
        <fieldset className="stack" disabled={!codeOk || !agreed}>
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
        </fieldset>
      </form>
    </PublicLayout>
  );
}
