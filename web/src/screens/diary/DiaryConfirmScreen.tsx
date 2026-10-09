/*
 * 日誌確認画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「申請前の内容確認」
 *
 * 入力→確認の段階を設ける（同「画面の洗い出しの考え方」(3-1) 基準2）。
 * ここで確定するのは「申請」であり、承認ではない。
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../../session';
import { api, childName, className } from '../../api/client';
import { Alert, Empty } from '../../components/ui';
import { notify } from '../../components/feedback';
import { DIARY_RECORD_TYPE } from '../../api/codes';
import { formatYMD } from '../../api/util';
import type { DiaryRecordType } from '../../api/types';

interface ConfirmState {
  recordType: DiaryRecordType;
  childId: string | null;
  classId: number | null;
  date: string;
  body: string;
  diaryId: number | null;
  lockToken?: string;
  photos: string[];
}

export default function DiaryConfirmScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const state = useLocation().state as ConfirmState | null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!state) {
    return <Empty text="確認する内容がありません。日誌の作成画面から進んでください。" />;
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveDiary(user!, {
        diary_id: state.diaryId ?? undefined,
        record_type: state.recordType,
        child_id: state.childId,
        class_id: state.classId,
        diary_date: state.date,
        body: state.body,
        lock_token: state.lockToken,
      }, '2');
      notify('日誌を申請しました。管理者の承認待ちになります');
      navigate('/staff/diary');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head"><h1>この内容で申請します</h1></div>
      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        <table className="list">
          <tbody>
            <tr><th scope="col" style={{ width: 140 }}>記録種別</th><td>{DIARY_RECORD_TYPE[state.recordType]}</td></tr>
            <tr><th scope="col">対象</th><td>{state.childId ? childName(state.childId) : className(state.classId)}</td></tr>
            <tr><th scope="col">記録日</th><td>{formatYMD(state.date)}</td></tr>
            <tr><th scope="col">写真</th><td>{state.photos.length} 枚</td></tr>
          </tbody>
        </table>
        <h3 style={{ marginTop: 16 }}>本文</h3>
        <div style={{ whiteSpace: 'pre-wrap', border: '1px solid var(--c-border)', borderRadius: 6, padding: 12 }}>
          {state.body}
        </div>
      </section>

      <section className="card card-sub">
        <div className="muted">
          申請すると管理者の承認待ちになります。保護者への共有は、承認の操作とあわせて管理者が指定します
          （基本設計書「日誌の作成から保護者への共有」(4-5)）。
        </div>
      </section>

      <div className="row-end">
        {/* 入力していた内容を持って戻る。履歴を戻るだけでは、保存していない入力が消える */}
        <button disabled={busy} onClick={() => navigate(
          state.diaryId ? `/staff/diary/${state.diaryId}` : '/staff/diary/new',
          { state: { draft: state }, replace: true },
        )}>戻る</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? '申請しています…' : '申請する'}
        </button>
      </div>
    </div>
  );
}
