/*
 * 日誌承認画面（管理者）
 * 典拠：図/画面詳細図.md「日誌承認画面（管理者）」(3-3)
 *
 * 共有の指定を承認と同じ画面に置く。承認後に別画面で指定させると共有し忘れが起きるため。
 * 差し戻しは理由の入力を必須とする。何を直せばよいかが作成者に伝わらないため。
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, childName, className, staffName } from '../../api/client';
import { Loading, ErrorBox, Field, Alert, Radios } from '../../components/ui';
import { DIARY_RECORD_TYPE } from '../../api/codes';
import { formatYMD, formatMDHM } from '../../api/util';

export default function DiaryApproveScreen() {
  const { user } = useSession();
  const { id } = useParams();
  const navigate = useNavigate();
  const diaryId = Number(id);

  const diary = useAsync(() => api.getDiary(user!, diaryId), [diaryId]);
  const attachments = useAsync(() => api.attachmentsOf(diaryId), [diaryId]);
  const templates = useAsync(() => api.templates(), []);

  const [share, setShare] = useState<'yes' | 'no' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * 【要確認】「共有する」の既定値を「する／しない」のどちらに置くかは未定（画面詳細図 3-3）。
   * モックでは既定値を置かず、雛形が持つ default_share_to_guardian を初期選択として提示している。
   * 雛形側に既定値を持たせる方針は基本設計書 5-4 に沿う。
   */
  useEffect(() => {
    const d = diary.data;
    const t = templates.data;
    if (!d || !t || share !== null) return;
    const tpl = t.find((x) => x.record_type === d.record_type);
    setShare(tpl?.default_share_to_guardian ? 'yes' : 'no');
  }, [diary.data?.diary_id, templates.data]);

  if (diary.loading) return <Loading />;
  if (diary.error) return <ErrorBox text={diary.error} />;
  const d = diary.data;
  if (!d) return null;

  const approve = async () => {
    setBusy(true); setError(null);
    try {
      await api.approveDiary(user!, diaryId, share === 'yes');
      navigate('/staff/admin/approval');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const sendBack = async () => {
    setBusy(true); setError(null);
    try {
      await api.returnDiary(user!, diaryId, reason);
      navigate('/staff/admin/approval');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const isPersonal = d.record_type === '1';

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/admin/approval">&lt; 承認待ち一覧へ</Link>
        <div className="spacer" />
        <span className="muted">申請 {formatMDHM(d.updated_at)}　作成者 {staffName(d.created_staff_id)}</span>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        <h2>
          {DIARY_RECORD_TYPE[d.record_type]} ／ {d.child_id ? childName(d.child_id) : className(d.class_id)}
          {' '}／ 記録日 {formatYMD(d.diary_date)}
        </h2>
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

      {/* 保護者への共有。承認と同じ画面で指定する */}
      <section className="card">
        <h2>保護者への共有</h2>
        {isPersonal ? (
          <>
            <Radios name="share" value={share}
              options={[{ value: 'yes', label: '共有する' }, { value: 'no', label: '共有しない' }]}
              onChange={setShare} />
            <div className="muted" style={{ marginTop: 8 }}>
              共有先：{childName(d.child_id)} 保護者（個人チャット）
            </div>
          </>
        ) : (
          <div className="muted">
            {DIARY_RECORD_TYPE[d.record_type]}は特定の園児に紐づかないため、個人チャットへの共有先がありません。
            <br />
            【要確認】クラス日誌・週案の共有先（クラスチャットへ流すか、共有しないか）は未定です。
          </div>
        )}
      </section>

      <section className="card">
        <Field label="差し戻す理由（差し戻すときのみ入力）">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} style={{ minHeight: 90 }}
            placeholder="何を直せばよいかが作成者に伝わるように書いてください" />
        </Field>
      </section>

      <div className="row-end">
        <button className="btn-danger" onClick={sendBack} disabled={busy || !reason.trim()}>差し戻す</button>
        <button className="btn-primary" onClick={approve} disabled={busy || (isPersonal && share === null)}>承認する</button>
      </div>
    </div>
  );
}
