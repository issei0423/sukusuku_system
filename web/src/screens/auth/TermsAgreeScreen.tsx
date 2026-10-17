/*
 * 利用規約同意画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)・「画面遷移」(3-4)
 *
 * 規約の改定時に次回ログインで表示する。同意を完了するまで他の画面へ進めない。
 */
import { startTransition, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout from '../../layouts/PublicLayout';
import { Alert } from '../../components/ui';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';

export default function TermsAgreeScreen({ readOnly }: { readOnly?: boolean }) {
  const { user, setUser, logout } = useSession();
  const navigate = useNavigate();
  const terms = useAsync(() => api.currentTerms(), []);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await api.agreeTerms(user.account_id);
      const u = await api.reloadSession(user.account_id);
      /*
       * 利用者の更新と画面の移動を同じ描画で行う。ルータは場所の更新を startTransition で行うため、
       * 利用者だけを先に更新すると、強制の経路の出し分け（App.tsx の RequireProcedure）が、
       * 同意を終えた利用者を利用規約の参照へ送り直してしまう（GitHub Issue #178 の 4）
       */
      startTransition(() => {
        setUser(u);
        navigate(u.role === '3' ? '/guardian' : '/staff');
      });
    } finally {
      setBusy(false);
    }
  };

  // メニューから開いたとき（同意済みの規約を読み返すだけ）
  if (readOnly) {
    return (
      <div>
        <div className="page-head"><h1>利用規約</h1></div>
        <section className="card">
          <div className="terms-box" tabIndex={0} aria-label="利用規約の本文" style={{ maxHeight: 480 }}>{terms.data?.body ?? '読み込んでいます…'}</div>
          <div className="muted" style={{ marginTop: 8 }}>
            現在の版：{terms.data?.terms_version}（施行日 {terms.data?.published_on}）
          </div>
        </section>
      </div>
    );
  }

  return (
    <PublicLayout wide>
      <h1 style={{ marginBottom: 12 }}>利用規約への同意</h1>
      {/* 初めてログインした人にも出る画面である。「改定しました」とだけ書かない（GitHub Issue #126） */}
      <Alert>
        ご利用の前に、利用規約の内容をご確認のうえ、同意をお願いします。
        規約を改定したときも、この画面で改めて同意をお願いしています。
      </Alert>
      <div className="terms-box" tabIndex={0} aria-label="利用規約の本文" style={{ marginTop: 16, maxHeight: 300 }}>
        {terms.data?.body ?? '読み込んでいます…'}
      </div>
      <label style={{ marginTop: 12 }}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        利用規約に同意します
      </label>
      <div className="stack" style={{ marginTop: 16 }}>
        <button className="btn-primary btn-block" disabled={!agreed || busy} onClick={submit}>同意して進む</button>
        {/* 同意しない選択も残す。同意しないままでは利用できないことを明示する */}
        <button className="btn-block"
          onClick={async () => {
            // ログインしていた系統の入口へ戻す（画面詳細図「利用規約同意画面」(2-5)）
            const top = user && user.role !== '3' ? '/staff-top' : '/';
            await logout(); navigate(top);
          }}>同意せずログアウトする</button>
      </div>
    </PublicLayout>
  );
}
