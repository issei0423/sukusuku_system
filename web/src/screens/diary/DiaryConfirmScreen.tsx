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
import { focusAfter, focusedNow } from '../../focusAfter';
import type { DiaryRecordType } from '../../api/types';
import { IncidentSummary } from './IncidentFields';
import { incidentInputOf } from './incidentForm';
import type { IncidentForm } from './incidentForm';

interface ConfirmState {
  recordType: DiaryRecordType;
  childId: string | null;
  classId: number | null;
  date: string;
  body: string;
  diaryId: number | null;
  lockToken?: string;
  photos: DiaryAttachmentInput[];
  /** ヒヤリハットの欄（記録種別がヒヤリハットのときだけ。本文の代わりに送る） */
  incident?: IncidentForm;
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

  /*
   * 申請している間は「申請する」が押せなくなり、押したボタンからフォーカスが外れて body に落ちる。
   * 申請できなかったときは画面が残るので、押した「申請する」へ戻す（src/focusAfter.ts、WCAG 2.4.3、GitHub Issue #213）。
   * 申請できたら一覧へ移り、画面の移り変わりが本文（main）へ移す（App.tsx）
   */
  const submit = async () => {
    const pressed = focusedNow();
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
        // ヒヤリハットは本文の代わりに欄を送る。本文はサーバ（モック）が欄から作る（詳細設計書「日誌」(4-13 (1))）
        incident: state.recordType === '4' && state.incident ? incidentInputOf(state.incident) : undefined,
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
      focusAfter(pressed);
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
        {/* ヒヤリハットは本文の代わりに欄を示す（図/画面詳細図.md「日誌承認画面（管理者）」(3-5) 項目3 と同じ並び） */}
        {state.recordType === '4' && state.incident ? (
          <>
            <h3 style={{ marginTop: 16 }}>ヒヤリハットの内容</h3>
            <IncidentSummary incident={incidentInputOf(state.incident)} />
          </>
        ) : (
          <>
            <h3 style={{ marginTop: 16 }}>本文</h3>
            <div style={{ whiteSpace: 'pre-wrap', border: '1px solid var(--c-border)', borderRadius: 6, padding: 12 }}>
              {state.body}
            </div>
          </>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          申請すると管理者の承認待ちになります。
          {/* 日誌は園内の記録で、承認しても保護者へは届かない（基本設計書「日誌システム（園内の記録）」(4-6)） */}
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
