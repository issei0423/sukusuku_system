/*
 * 日誌承認画面（管理者）
 * 典拠：図/画面詳細図.md「日誌承認画面（管理者）」(3-3)、詳細設計書.md「日誌の画面（作り直し）」(2-13 (1))
 *
 * 承認は園内の確認であり、保護者へは何も届かない（基本設計書「日誌システム（園内の記録）」(4-6)）。
 * そのため「承認する」は確認のダイアログを出さず、押した時点で承認する。取り消しは日誌作成・編集画面の
 * 「承認を取り消して差し戻す」で行う（詳細設計書 (2-13 (3))）。
 * 差し戻しは理由の入力を必須とする。何を直せばよいかが作成者に伝わらないため。
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, childName, className, staffName } from '../../api/client';
import { Loading, ErrorBox, Field, Alert } from '../../components/ui';
import { notify } from '../../components/feedback';
import { DIARY_RECORD_TYPE, DIARY_STATUS } from '../../api/codes';
import { formatYMD, formatMDHM } from '../../api/util';

export default function DiaryApproveScreen() {
  const { user } = useSession();
  const { id } = useParams();
  const navigate = useNavigate();
  const diaryId = Number(id);

  const diary = useAsync(() => api.getDiary(user!, diaryId), [diaryId]);
  const attachments = useAsync(() => api.attachmentsOf(user!, diaryId), [diaryId]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (diary.loading) return <Loading />;
  if (diary.error) return <ErrorBox text={diary.error} />;
  const d = diary.data;
  if (!d) return null;

  const target = d.child_id ? childName(d.child_id) : className(d.class_id);
  /*
   * 自分が申請した日誌は承認できない。その旨を表示し、承認のボタンを押せなくする
   * （図/画面詳細図.md「日誌承認画面（管理者）」(3-5)。演習上の想定。GitHub Issue #106）。
   * 判定は申請者（applied_staff_id）で行う。作成者が自分でも、ほかの職員が申請したものは承認できる
   * （詳細設計書「日誌の状態」(3-6)。GitHub Issue #174）
   */
  const applicant = d.applied_staff_id ?? null;
  const own = !!applicant && applicant === user!.staff_id;
  // 開いたあとに取り下げ・承認・差し戻しが済んでいたら、承認も差し戻しもできない（サーバも 409 で断る）
  const pending = d.status === '2';

  const approve = async () => {
    setBusy(true); setError(null);
    try {
      await api.approveDiary(user!, diaryId);
      notify(`${target}の${DIARY_RECORD_TYPE[d.record_type]}を承認しました`);
      navigate('/staff/admin/approval');
    } catch (e) { setError((e as Error).message); diary.reload(); } finally { setBusy(false); }
  };

  const sendBack = async () => {
    setBusy(true); setError(null);
    try {
      await api.returnDiary(user!, diaryId, reason);
      notify(`${target}の${DIARY_RECORD_TYPE[d.record_type]}を差し戻しました`);
      navigate('/staff/admin/approval');
    } catch (e) { setError((e as Error).message); diary.reload(); } finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/admin/approval">&lt; 承認待ち一覧へ</Link>
        <h1>日誌の承認</h1>
        <div className="spacer" />
        {/* 申請者・申請日時（詳細設計書「日誌の画面（作り直し）」(2-13 (1))）。作成者とは別の職員が申請することがある */}
        <span className="muted">
          {applicant && d.applied_at && `申請 ${formatMDHM(d.applied_at)}　申請者 ${staffName(applicant)}　`}
          作成者 {staffName(d.created_staff_id)}
        </span>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}
      {!pending && (
        <div style={{ marginBottom: 16 }}>
          {/* 【仮置き】文言（web/仮置き値.md「承認画面で承認待ちでなくなった日誌」） */}
          <Alert soft>
            いまの状態は「{DIARY_STATUS[d.status]}」のため、承認・差し戻しはできません。承認待ち一覧へ戻ってください。
          </Alert>
        </div>
      )}
      {pending && own && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>
            自分が申請した日誌は承認できません。ほかの管理者に承認を依頼してください。差し戻して書き直すことはできます。
          </Alert>
        </div>
      )}

      <section className="card">
        <h2>
          {DIARY_RECORD_TYPE[d.record_type]} ／ {d.child_id ? childName(d.child_id) : className(d.class_id)}
          {' '}／ 記録日 {formatYMD(d.diary_date)}
        </h2>
        {/*
          * 差し戻したことのある日誌は、前回の差し戻しの理由を出す。理由は承認されるまで残し、
          * 承認者が前回の指摘を見ながら確かめられるようにする（基本設計書「日誌（t_diary）」(5-4)。GitHub Issue #174）
          */}
        {d.returned_reason && (
          <div style={{ marginBottom: 12 }}>
            <Alert soft>前回差し戻した理由：{d.returned_reason}</Alert>
          </div>
        )}
        {/* 本文は読み取り専用。承認者が書き換えられないようにする */}
        <div style={{ whiteSpace: 'pre-wrap', border: '1px solid var(--c-border)', borderRadius: 6, padding: 12, background: 'var(--c-surface-sub)' }}>
          {d.body}
        </div>
        {(attachments.data?.length ?? 0) > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="muted">写真</span>
            {attachments.data!.map((a, i) => (
              <span key={a.diary_attachment_id} className="tag tag-plain" style={{ padding: '14px 20px' }}>{i + 1}</span>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <Field label="差し戻す理由（差し戻すときのみ入力）">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} style={{ minHeight: 90 }} maxLength={500}
            placeholder="何を直せばよいかが作成者に伝わるように書いてください" />
        </Field>
      </section>

      <div className="row-end">
        <button className="btn-danger" onClick={sendBack} disabled={busy || !pending || !reason.trim()}>差し戻す</button>
        <button className="btn-primary" onClick={approve} disabled={busy || !pending || own}>承認する</button>
      </div>

    </div>
  );
}
