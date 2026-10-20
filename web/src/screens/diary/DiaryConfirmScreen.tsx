/*
 * 日誌確認画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「申請前の内容確認」
 *
 * 入力→確認の段階を設ける（同「画面の洗い出しの考え方」(3-1) 基準2）。
 * ここで確定するのは「申請」であり、承認ではない。
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { acquireDiaryLock, consumeDiaryLockHandOver, keepDiaryLock, releaseDiaryLockLater, releaseDiaryLockNow } from './diaryLock';
import { useSession } from '../../session';
import { api, childName, className } from '../../api/client';
import type { DiaryAttachmentInput } from '../../api/client';
import { Alert, Empty } from '../../components/ui';
import { clearNotice, notify } from '../../components/feedback';
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
  photos: DiaryAttachmentInput[];
}

export default function DiaryConfirmScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const state = useLocation().state as ConfirmState | null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  // 編集画面へ戻るときは、ロックを編集画面へ返す（外さない。編集画面が取り直す）
  const handBackRef = useRef(false);

  /*
   * 編集画面から引き継いだ編集ロックを、申請するか画面を離れるまで持つ（基本設計書「編集ロックの解除」(4-5)）。
   * 確認画面へ移った時点で外すと、確認画面にいる間にほかの職員が開いて直せてしまい、申請がその直しを
   * 黙って上書きする（GitHub Issue #166 の 1 の手順 B）。申請するとサーバが外す
   */
  const lockDiaryId = state?.diaryId ?? null;
  useEffect(() => {
    if (!lockDiaryId || !state?.lockToken) return;
    let token: string | null = null;
    let cancelled = false;
    const attach = (next: string) => {
      token = next;
      if (cancelled) { releaseDiaryLockLater(user!, lockDiaryId, next); return; }
      keepDiaryLock(lockDiaryId, next);
      setActiveToken(next);
    };
    if (consumeDiaryLockHandOver(lockDiaryId, state.lockToken)) {
      attach(state.lockToken);
    } else {
      // 読み込み直し・履歴移動で pagehide が古いロックを外すため、確認画面で取得し直す。
      // 基本設計書「同時編集の検出」(4-2) に従い、他者が持つ場合は申請させない。
      void acquireDiaryLock(user!, lockDiaryId).then((result) => {
        if (!('token' in result)) {
          if (!cancelled) setError(`${result.heldBy}さんが編集中です。日誌の作成画面へ戻ってください。`);
          return;
        }
        attach(result.token);
      }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    }
    const onPageHide = () => { if (token) void releaseDiaryLockNow(user!, lockDiaryId, token); };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onPageHide);
      if (token && !handBackRef.current) releaseDiaryLockLater(user!, lockDiaryId, token);
    };
  }, [user, lockDiaryId, state?.lockToken]);

  // 申請の直前に、前の画面の「下書きを保存しました」を残さない（GitHub Issue #139 の 2）
  useEffect(() => { clearNotice(); }, []);

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
        lock_token: activeToken ?? undefined,
        // ここで示した写真を、そのまま日誌に付ける（画面詳細図「日誌確認画面」(3-3) 項目3。GitHub Issue #175 の 2）
        attachments: state.photos,
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
          申請すると管理者の承認待ちになります。保護者への共有は、承認の操作とあわせて管理者が指定します。
          {/* 共有は承認の操作とあわせて管理者が指定する（基本設計書「日誌の作成から保護者への共有」(4-5)） */}
        </div>
      </section>

      <div className="row-end">
        {/* 入力していた内容を持って戻る。履歴を戻るだけでは、保存していない入力が消える */}
        <button disabled={busy} onClick={() => {
          handBackRef.current = true;
          navigate(
            state.diaryId ? `/staff/diary/${state.diaryId}` : '/staff/diary/new',
            { state: { draft: state }, replace: true },
          );
        }}>戻る</button>
        <button className="btn-primary" onClick={submit} disabled={busy || (!!state.diaryId && !activeToken)}>
          {busy ? '申請しています…' : '申請する'}
        </button>
      </div>
    </div>
  );
}
