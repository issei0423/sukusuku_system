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

/** 保護者の氏名の上限（基本設計書「入力項目の制約値」(4-9)「氏名・かな（園児・職員・保護者）｜各50文字以内」） */
const NAME_MAX = 50;

export default function SignUpScreen() {
  const navigate = useNavigate();
  const { user, setUser, setEntrance } = useSession();
  const terms = useAsync(() => api.currentTerms(), []);
  // ログインより前に開いておいたタブから送り、サーバに断られたとき（下の submit）
  const [loggedInElsewhere, setLoggedInElsewhere] = useState(false);

  const [code, setCode] = useState('');
  const [codeOk, setCodeOk] = useState(false);
  /*
   * 同意した規約の版。同意のチェックを入れたときに画面に出していた版を持ち、登録のときに送る。
   * サーバは、この版がいま有効な版と同じときだけ同意を記録する。同意は要配慮個人情報を取り扱う根拠であり、
   * どの版に同意したかを後から示せる必要がある（基本設計書「同意履歴（t_terms_agreement）」(5-2)。GitHub Issue #170）
   */
  const [agreedVersion, setAgreedVersion] = useState<string | null>(null);
  const agreed = agreedVersion !== null;
  const [name, setName] = useState('');
  /*
   * 続柄の初期値は未選択（空）。職員がお迎えの人を確かめる手がかりになるため、初期値で埋めない
   * （画面詳細図「新規登録画面（保護者）」(2-3) 項目11「初期値：未選択」。第2.3版、PR #216）。
   * 「母」を初期値にしておくと、父や祖母が選び忘れたまま登録しても通ってしまう
   */
  const [relationship, setRelationship] = useState('');
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
    if (!codeOk || agreedVersion === null) { setError('招待コードの確認と利用規約への同意を済ませてください'); return; }
    // 送る前に画面でも確かめる。検査の担保はサーバ側が行う（基本設計書「入力項目の制約値」(4-9)）
    if (!name.trim()) { setError('保護者の氏名を入力してください'); return; }
    if ([...name.trim()].length > NAME_MAX) { setError(`保護者の氏名は${NAME_MAX}文字以内で入力してください`); return; }
    // 続柄は必須（画面詳細図 2-3 項目11「選ばないと登録できない」）。文言はサーバ（server/api_auth.go）と同じ
    if (!relationship) { setError('続柄は 母・父・祖母・祖父・その他 から選んでください'); return; }
    const emailError = validateEmail(email);
    if (emailError) { setError(emailError); return; }
    // 8〜128文字（文字数で数える）。よく使われるパスワードは使えない（基本設計書 4-9・6-3。GitHub Issue #159）
    const passwordError = validateNewPassword(password);
    if (passwordError) { setError(passwordError); return; }
    if (password !== password2) { setError('パスワードが一致しません'); return; }
    setBusy(true);
    try {
      const u = await api.signUpGuardian({
        code, email, password, guardian_name: name, relationship,
        terms_agreed: true, terms_version: agreedVersion,
      });
      setEntrance('guardian');
      setUser(u);
      navigate('/guardian');
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('"already_logged_in"')) { setLoggedInElsewhere(true); return; }
      setError(message);
      /*
       * 送るまでのあいだに規約が改定されていたら、サーバは同意を受け付けない。改定後の本文を出し直し、
       * 読んでから同意し直してもらう（読んでいない版に同意したことにしない）
       */
      const latest = await api.currentTerms().catch(() => null);
      if (latest && latest.terms_version !== agreedVersion) {
        setAgreedVersion(null);
        terms.reload();
      }
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
        {/* 本文を読み込めるまで同意させない。読んでいない規約に同意したことにしないため */}
        <fieldset disabled={!codeOk || !terms.data}>
          <label style={{ marginTop: 8 }}>
            <input type="checkbox" checked={agreed}
              onChange={(e) => setAgreedVersion(e.target.checked && terms.data ? terms.data.terms_version : null)} />
            利用規約に同意します
          </label>
        </fieldset>
      </div>

      {/* (3) アカウント情報 */}
      <form className={`step${codeOk && agreed ? '' : ' locked'}`} aria-disabled={!codeOk || !agreed} onSubmit={submit}>
        <div className="step-title">(3) アカウント情報</div>
        <fieldset className="stack" disabled={!codeOk || !agreed}>
          <Field label="保護者の氏名" required>
            <input type="text" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
          </Field>
          {/* 残りの文字数を入力欄に示す。保存しようとして初めて弾かれる作りにしない（基本設計書「入力項目の制約値」(4-9)） */}
          <div className="muted" aria-live="polite">残り {NAME_MAX - [...name].length} 文字</div>
          <Field label="続柄" required>
            <select value={relationship} onChange={(e) => setRelationship(e.target.value)}>
              <option value="">選んでください</option>
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
