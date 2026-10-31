/*
 * 保護者アカウント管理画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *      「紐づけの解除、アカウントの停止、未同意者の確認」
 *
 * 紐づけ単位で終了させる。アカウントの停止は有効な紐づけがゼロになった時点（基本設計書 5-3）で、システムが行う。
 * 管理者が保護者アカウントを手で停止・再開するボタンは置かない（基本設計書「アカウントの停止と再開」(4-3)、
 * 図/画面詳細図「保護者アカウント管理画面」(7-8) 項目5「置かない」。GitHub Issue #272）。
 * 止めるときは紐づけの解除、戻すときは「紐づけを戻す」（停止していたアカウントもあわせて再開する。GitHub Issue #118）。
 * 「結び直す」は、新しい招待コードで結んだときと同じく、解除していたあいだのやりとりを読ませずに結ぶ。解除から RESTORE_LINK_DAYS 日の
 * 内は「紐づけを戻す」（誤って解除したとき）と「結び直す」（親権の変更・家庭の事情で解除したあとに改めて結ぶとき）を並べ、
 * 過ぎたら「結び直す」だけを出す。最後の紐づけを解除してアカウントが止まった保護者はログインできず、新しい招待コードを
 * 使えないので、改めて結ぶ道は「結び直す」になる（照合 c5-04 と頭役の決め。【仮置き】web/仮置き値.md）。
 */
import { useState } from 'react';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Alert, Tag } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import { ACCOUNT_STATUS, LINK_STATUS, RESTORE_LINK_DAYS } from '../../api/codes';
import { formatYMD, today } from '../../api/util';

/**
 * 終了した紐づけを、いま「紐づけを戻す」（解除のあいだも読める形）で戻せるか。過ぎていれば「結び直す」。
 * 戻せる最後の日はサーバが返す（restore_until）。どちらになるかの最後の判定はサーバが行う
 */
const canRestore = (restoreUntil: string | undefined) => !!restoreUntil && today() <= restoreUntil;

type LinkTarget = {
  guardianId: string; childId: string; guardianName: string; childName: string; last: boolean; stopped: boolean;
  /** いま「紐づけを戻す」も選べるか（解除から RESTORE_LINK_DAYS 日の内） */
  restorable: boolean;
};
type Pending =
  | ({ kind: 'end' } & LinkTarget)
  | ({ kind: 'restore' } & LinkTarget)
  | ({ kind: 'relink' } & LinkTarget);

export default function GuardianAccountsScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  const { data, error: loadError, loading } = useAsync(() => api.guardianAccounts(user!), [tick]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const run = async () => {
    if (!pending) return;
    setError(null); setBusy(true);
    try {
      if (pending.kind === 'end') {
        await api.endGuardianLink(user!, pending.guardianId, pending.childId);
        notify(`${pending.guardianName} さんと ${pending.childName} の紐づけを解除しました`);
      } else {
        // 戻すのも結び直すのも同じ経路。結び直すときは relink を添える（期間を過ぎていれば、添えなくてもサーバが結び直す）
        await api.restoreGuardianLink(user!, pending.guardianId, pending.childId, pending.kind === 'relink');
        notify(pending.kind === 'relink'
          ? `${pending.guardianName} さんと ${pending.childName} の紐づけを結び直しました`
          : `${pending.guardianName} さんと ${pending.childName} の紐づけを戻しました`);
      }
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setPending(null); }
  };

  const notAgreed = data?.filter((r) => !r.termsAgreed) ?? [];

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head"><h1>保護者アカウント</h1></div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      {/* 未同意者の確認。次のログインで同意画面が出るので、警告の帯でなく知らせの帯（札の「未同意」の青と同じ扱い。r2c-02） */}
      {notAgreed.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>
            最新版の利用規約に同意していない保護者が {notAgreed.length} 名います：
            {notAgreed.map((r) => r.guardian.guardian_name).join('、')}
            。次回のログイン時に同意画面を表示します。
          </Alert>
        </div>
      )}

      <section className="card">
        {loading && <Loading />}
        {loadError && <ErrorBox text={loadError} />}
        {data?.length === 0 && <Empty text="保護者アカウントはありません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th scope="col">保護者</th><th scope="col">ログインID</th><th scope="col">電話番号</th><th scope="col">紐づく園児</th><th scope="col">規約</th><th scope="col">状態</th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.guardian.guardian_id}>
                  <td className="nowrap">{r.guardian.guardian_name}</td>
                  <td className="nowrap muted">{r.account.email}</td>
                  <td className="nowrap">{r.guardian.phone_number ?? '―'}</td>
                  <td>
                    {r.links.length === 0 && <span className="muted">―</span>}
                    {r.links.map((l) => {
                      const base = {
                        guardianId: r.guardian.guardian_id, childId: l.child_id,
                        guardianName: r.guardian.guardian_name, childName: l.child_name,
                        last: r.activeLinks === 1, stopped: r.account.status === '2',
                        restorable: canRestore(l.restore_until),
                      };
                      return (
                        <div key={l.child_id} className="row" style={{ gap: 6 }}>
                          <span>{l.child_name}（{l.relationship}）</span>
                          <Tag label={LINK_STATUS[l.link_status]}
                            className={l.link_status === '1' ? 'tag-approved' : 'tag-draft'} />
                          {l.link_status === '1' && (
                            <button className="btn-sm btn-quiet" onClick={() => setPending({ kind: 'end', ...base })}>
                              解除
                            </button>
                          )}
                          {l.ended_at && <span className="weak">（{formatYMD(l.ended_at.slice(0, 10))} 終了）</span>}
                          {l.link_status === '2' && canRestore(l.restore_until) && (
                            <button className="btn-sm btn-quiet" onClick={() => setPending({ kind: 'restore', ...base })}>
                              紐づけを戻す
                            </button>
                          )}
                          {/* 終了した紐づけには「結び直す」を出す。期間の内は「紐づけを戻す」と並べる（解除していたあいだのやりとりは読めない。【仮置き】web/仮置き値.md） */}
                          {l.link_status === '2' && (
                            <button className="btn-sm btn-quiet" onClick={() => setPending({ kind: 'relink', ...base })}>
                              結び直す
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </td>
                  <td className="nowrap">
                    {r.termsAgreed
                      ? <Tag label="同意済" className="tag-approved" />
                      : <Tag label="未同意" className="tag-applied" />}
                  </td>
                  <td className="nowrap">
                    <Tag label={ACCOUNT_STATUS[r.account.status]}
                      className={r.account.status === '1' ? 'tag-approved' : 'tag-draft'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          {/* 紐づけ単位で終了させ、有効な紐づけがゼロになった時点で停止する（基本設計書「クラスと紐づけ」(5-3)） */}
          紐づけは園児ごとに終了させます。有効な紐づけがゼロになった時点で、アカウントは自動的に停止されます。
          <br />
          {/* 戻すのは誤って解除したときに限る（基本設計書「保護者と園児の紐づけを戻す」(4-3)） */}
          誤って解除したときだけ「紐づけを戻す」を使ってください。戻せるのは、解除した日から{RESTORE_LINK_DAYS}日までです。
          紐づけを戻すと、停止していたアカウントも再開され、解除していたあいだのやりとりも読めるようになります。
          {/* 親権の変更・家庭の事情で解除したあとは結び直す。止まったアカウントの保護者は新しい招待コードを使えない（照合 c5-04 と頭役の決め。【仮置き】web/仮置き値.md） */}
          親権の変更や家庭の事情で解除したあとに改めて結ぶときは、戻さずに「結び直す」を使ってください。{RESTORE_LINK_DAYS}日を過ぎた紐づけは「結び直す」だけになります。
          結び直すと、新しい招待コードで紐づけたときと同じく、個人チャットは結び直したあとのやりとりから読めます（解除していたあいだのやりとりは読めません）。停止していたアカウントは再開されます。
          <br />
          {/* 保護者は left_at が入った時点でチャンネルごと参照できなくなる（基本設計書「チャット」(5-6)。第2.x版の番号では 5-5） */}
          紐づけを終了しても、その保護者が参加していた期間のやりとりは記録として残ります。
          ただし保護者側からは参照できなくなります。
        </div>
      </section>

      {pending?.kind === 'end' && (
        <ConfirmDialog title="紐づけの解除" confirmLabel="解除する" danger busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.guardianName} さんと {pending.childName} の紐づけを終了します。</p>
          <p>解除すると、{pending.guardianName} さんは {pending.childName} の記録とチャットを参照できなくなります。</p>
          {pending.last && (
            <Alert>
              これが最後の有効な紐づけです。解除すると {pending.guardianName} さんのアカウントは停止されます。
            </Alert>
          )}
        </ConfirmDialog>
      )}
      {pending?.kind === 'restore' && (
        <ConfirmDialog title="紐づけを戻す" confirmLabel="戻す" busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.guardianName} さんと {pending.childName} の紐づけを、有効に戻します。</p>
          {/* 戻すとチャットの参加の left_at を消すので、解除していたあいだのやりとりも読める（server/api_admin.go の rejoinRoomsOfChild）。
              戻すのは誤って解除したときに限る（基本設計書「保護者と園児の紐づけを戻す」(4-3)） */}
          <p>戻すと、{pending.guardianName} さんは {pending.childName} の記録とチャットを参照できるようになります。解除していたあいだのやりとりも読めるようになります。</p>
          <p>戻すのは、誤って解除したときだけです。親権の変更や家庭の事情で解除したあとに改めて結ぶときは、戻さずに「結び直す」を使ってください。</p>
          {pending.stopped && (
            <Alert soft>{pending.guardianName} さんのアカウントは停止中です。紐づけを戻すと、あわせて再開されます。</Alert>
          )}
        </ConfirmDialog>
      )}
      {pending?.kind === 'relink' && (
        <ConfirmDialog title="紐づけを結び直す" confirmLabel="結び直す" busy={busy}
          onConfirm={run} onCancel={() => setPending(null)}>
          <p>{pending.guardianName} さんと {pending.childName} の紐づけを、結び直します。</p>
          {/* 新しい招待コードで結んだときと同じく今の時刻でチャットに入り直す
              （server/api_admin.go の handleRestoreGuardianLink・joinRoomsOfChildNow。決めたこと D-48。【仮置き】web/仮置き値.md） */}
          <p>新しい招待コードで紐づけたときと同じ扱いになります。{pending.guardianName} さんは {pending.childName} の記録とチャットを参照できるようになりますが、個人チャットは結び直したあとのやりとりから読めます。解除していたあいだのやりとりは読めません。</p>
          {pending.restorable
            ? <p>親権の変更や家庭の事情で解除したあとに改めて結ぶときに使います。誤って解除したときは「紐づけを戻す」を使ってください。</p>
            : <p>解除から{RESTORE_LINK_DAYS}日を過ぎているため、「紐づけを戻す」は使えません。</p>}
          {pending.stopped && (
            <Alert soft>{pending.guardianName} さんのアカウントは停止中です。結び直すと、あわせて再開されます。</Alert>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
