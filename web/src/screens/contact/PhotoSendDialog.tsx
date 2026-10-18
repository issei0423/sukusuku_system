/*
 * 写真を送る（連絡帳（クラス）画面の「写真を送る」・連絡帳（園児）画面の「写真」から開く）
 * 典拠：詳細設計書「写真を送る」(2-2 (7))・「写真」(3-3)・「押したときの処理の型」(2-0 (2))、
 *      基本設計書「写真の同意で止める規則」(4-2)・「送る時点の守り」(4-2)
 *
 * 写真は1回に1枚。① 写真を選ぶ（撮るか選ぶ。画面で向きを直し、長い辺 1600px・JPEG（品質 0.85）に描き直す）
 * → ② 写っている子を選ぶ（SubjectPickerDialog。同意を満たさない子がいれば「送る」を押せない。担保はサーバ）
 * → ③ 添える文（任意・200文字）と宛先（RecipientBadge）を見て「送る」（POST /api/contact/photos）。
 * 添える文に他児の名前があれば、サーバの 409 で「他児の名前の注意」を開き、「このまま送る」で承諾を付けて送り直す（決めたこと D-4）。
 * 押したらサーバの応答を待つ（楽観的更新をしない。決めたこと D-3）。送れなかったら入力を残し、近くに何が違うかを出す。
 * ③の添える文の欄の下に「成長の記録に残す」のチェックボックス（初期値オフ）を置き、keep_in_growth として送る。
 * 典拠：詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (1)) の「写真を送るとき」、画面詳細図「連絡帳（園児）画面」(8-2) の項目8。
 * 付けると写っている子の全員の出来事に付く（2人以上で付ける子を選ばせるかは【要決定】。要決定事項「決めてもらうこと」(1-3)）。
 * 【仮置き】③の中の位置は設計が決めていないので、ひとことの欄の下（同じ表の「ひとことを書いて送るとき」）に倣う（web/仮置き値.md）。
 *
 * 【仮置き】窓の題・段の見出し・欄の名前・途中の文（web/仮置き値.md）。
 * 窓は1つずつ出す（写っている子を選ぶ・他児の名前の注意を開く間は、この窓を閉じて入れ替える。Esc で両方が閉じないため）。
 * フォーカスは GitHub Issue #213 の決まりに沿う：窓を閉じたら開いた元（「写真を送る」）へ戻す。選び終えたら「写っている子を選ぶ」へ、
 * 他児の名前の注意で「直す」を選んだら添える文の欄へ移す。#226 の src/focusAfter.ts が入ったら、そちらへ寄せる
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, settingNumber } from '../../api/client';
import type { ContactClassView, NameMatch } from '../../api/shapes';
import { useSession } from '../../session';
import { useAsync } from '../../hooks';
import { useReachable } from '../../api/reachability';
import { useUnsavedInput } from '../../unsavedInput';
import { notify } from '../../components/feedback';
import { Alert, ErrorBox, Loading, Modal } from '../../components/ui';
import RecipientBadge from '../../components/RecipientBadge';
import NameCheckDialog from '../../components/NameCheckDialog';
import SubjectPickerDialog from '../../components/SubjectPickerDialog';
import { consentFailures } from '../../components/photoConsent';
import type { PickerChild, SubjectSelection } from '../../components/photoConsent';
import { TEXT, photoConsentMessage } from '../../messages';
import { cancelAction } from './FixDialog';
import { photoProblem, redrawPhoto } from './photoRedraw';
import '../../styles/contactPhoto.css';

type SendError = Error & { kind?: string; names?: string[]; matches?: NameMatch[] };

/** 添える文の上限（基本設計書「活動のひとこと・写真」(4-5)、詳細設計書 (2-2 (7)) の③） */
const BODY_MAX = 200;

export default function PhotoSendDialog({ classId, date, initialSubjects = [], onClose, onSent }: {
  /** 写っている子を選ぶ格子に並べるクラス */
  classId: number;
  date: string;
  /** 連絡帳（園児）画面から開いたときは、その子を選んだ状態で開く（詳細設計書 (2-3 (4))） */
  initialSubjects?: string[];
  onClose: () => void;
  /** 送れた。開いた画面を読み直す */
  onSent: () => void;
}) {
  const { user } = useSession();
  const fileId = useId();
  const bodyId = useId();
  const view = useAsync((): Promise<ContactClassView> => api.contactClass(user!, classId, date), [user?.account_id, classId, date]);
  const [mode, setMode] = useState<'main' | 'pick' | 'check'>('main');
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [selection, setSelection] = useState<SubjectSelection>({ subjects: initialSubjects, noChildren: false, target: null });
  const [body, setBody] = useState('');
  // 成長の記録に残す（詳細設計書 (2-12 (1))）。初期値はオフ。窓は開くたびに作り直すので、開けばオフへ戻る
  const [keepInGrowth, setKeepInGrowth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [check, setCheck] = useState<{ names: string[]; matches: NameMatch[]; text: string } | null>(null);
  const reachable = useReachable();
  useUnsavedInput(photo !== null || body.trim() !== '');

  // 窓を入れ替えたあとに、決めた場所へフォーカスを移す（窓の部品が窓の中の最初の欄へ置いたあとで動かす）
  const pickButton = useRef<HTMLButtonElement>(null);
  const bodyBox = useRef<HTMLTextAreaElement>(null);
  const focusTo = useRef<'pick' | 'body' | null>(null);
  useEffect(() => {
    if (mode !== 'main' || !focusTo.current) return;
    (focusTo.current === 'pick' ? pickButton.current : bodyBox.current)?.focus();
    focusTo.current = null;
  }, [mode]);

  // 選んだ写真の見本（描き直したもの）。URL を作れない環境（テスト）では出さない
  const preview = useMemo(() => (photo && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const rows = useMemo(() => view.data?.rows ?? [], [view.data]);
  const candidates: PickerChild[] = rows.map((r) => ({
    child_id: r.child.child_id, child_name: r.child.child_name, photo_consent_level: r.child.photo_consent_level,
  }));
  const recipientIds = selection.noChildren ? (selection.target ? [selection.target] : []) : selection.subjects;
  const recipientRows = recipientIds.map((id) => rows.find((r) => r.child.child_id === id)).filter((r) => !!r);
  const failures = consentFailures(candidates, selection.subjects);
  const ready = photo !== null && recipientIds.length > 0 && failures.length === 0 && !preparing;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const problem = photoProblem(file, settingNumber('attachment.max_size_mb', 10));
    if (problem) { setPhoto(null); setPhotoError(problem); return; }
    setPreparing(true); setPhotoError(null);
    try {
      setPhoto(await redrawPhoto(file));
    } catch (e) {
      setPhoto(null);
      setPhotoError((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };

  const send = async (acknowledged: string[]) => {
    if (!photo || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.sendPhoto(user!, {
        file: photo, subject_child_ids: selection.noChildren ? [] : selection.subjects,
        target_child_id: selection.noChildren ? selection.target : null, body: body.trim() || null,
        keep_in_growth: keepInGrowth, acknowledged_names: acknowledged,
      });
      const names = recipientRows.map((r) => r.child.child_name);
      // 送ったあとの文（基本設計書「メッセージ一覧」(4-12)）。届く家庭がまだ1つも登録していなければ「登録すると読めます」。
      // 【仮置き】前に「〇〇さんへの写真：」と、どこへ何を送ったかを足す（web/仮置き値.md。ひとこと・園からと同じ書き方）
      const registered = recipientRows.some((r) => r.recipient.relationships.length > 0);
      notify(`${names.map((n) => `${n}さん`).join('・')}への写真：${registered ? TEXT.sentToGuardian : TEXT.sentUnregistered}`,
        res.events[0] ? cancelAction(user!, { kind: 'event', event: res.events[0], childName: names[0] ?? '' }) : undefined);
      onSent();
    } catch (e) {
      const err = e as SendError;
      if (err.kind === 'other_child_names' && err.names) {
        setCheck({ names: err.names, matches: err.matches ?? [], text: body.trim() });
        setMode('check');
      } else {
        setError(err.message);
        setFailed(true);
        if (mode !== 'main') { focusTo.current = 'body'; setMode('main'); }
      }
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'pick') {
    return (
      <SubjectPickerDialog candidates={candidates} initial={selection}
        onClose={() => { focusTo.current = 'pick'; setMode('main'); }}
        onDone={(next) => { setSelection(next); focusTo.current = 'pick'; setMode('main'); }} />
    );
  }
  if (mode === 'check' && check) {
    return (
      <NameCheckDialog names={check.names} matches={check.matches} text={check.text} busy={busy}
        onFix={() => { setCheck(null); focusTo.current = 'body'; setMode('main'); }}
        onSend={() => void send(check.names)} />
    );
  }

  const subjectText = selection.noChildren
    ? `子どもは写っていない（届ける子：${recipientRows[0]?.child.child_name ?? 'まだ選んでいません'}）`
    : recipientRows.length > 0 ? `写っている子：${recipientRows.map((r) => r.child.child_name).join('・')}` : 'まだ選んでいません';

  return (
    <Modal title="写真を送る" onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}>やめる</button>
        <button type="button" className="btn-primary" onClick={() => void send([])} disabled={!ready || busy} aria-busy={busy}>
          {busy ? TEXT.sending : failed && !reachable ? TEXT.resend : '送る'}
        </button>
      </>}>
      {view.loading && <Loading />}
      {view.error && <ErrorBox text={view.error} />}
      {view.data && (
        <div className="photo-send">
          <section className="photo-send-step" aria-labelledby={`${fileId}-h`}>
            <h3 id={`${fileId}-h`}>① 写真を選ぶ</h3>
            <label className="photo-send-file" htmlFor={fileId}>
              <span>写真を撮る・選ぶ（1枚）</span>
              <input id={fileId} type="file" accept="image/jpeg,image/png" capture="environment" disabled={busy || preparing}
                onChange={(e) => void choose(e.target.files?.[0])} />
            </label>
            {preparing && <p className="muted" role="status">写真を整えています…</p>}
            {photoError && <p className="contact-error" role="alert">{photoError}</p>}
            {photo && !preparing && (
              preview ? <img className="photo-send-preview" src={preview} alt="選んだ写真" /> : <p className="muted">写真を選びました。</p>
            )}
          </section>

          <section className="photo-send-step" aria-labelledby={`${fileId}-s`}>
            <h3 id={`${fileId}-s`}>② 写っている子</h3>
            <p className="photo-send-subjects">{subjectText}</p>
            <button ref={pickButton} type="button" onClick={() => setMode('pick')} disabled={busy}>写っている子を選ぶ</button>
            {failures.length > 0 && (
              <Alert>{photoConsentMessage(failures.map((c) => c.child_name), selection.subjects.length)}</Alert>
            )}
          </section>

          <section className="photo-send-step" aria-labelledby={`${fileId}-b`}>
            <h3 id={`${fileId}-b`}>③ 添える文と宛先</h3>
            <label className="contact-field" htmlFor={bodyId}><span>添える文（なくても送れます）</span></label>
            <textarea ref={bodyBox} id={bodyId} value={body} maxLength={BODY_MAX} disabled={busy} onChange={(e) => setBody(e.target.value)} />
            <span className="muted contact-count" aria-live="polite">残り {BODY_MAX - [...body].length} 文字</span>
            {/* 成長の記録に残す（詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (1))、画面詳細図「連絡帳（園児）画面」(8-2) の項目8） */}
            <label className="photo-send-keep">
              <input type="checkbox" checked={keepInGrowth} disabled={busy} onChange={(e) => setKeepInGrowth(e.target.checked)} />
              成長の記録に残す
            </label>
            {recipientRows.length > 0 && (
              <div className="photo-send-badges">
                {recipientRows.map((r) => <RecipientBadge key={r.child.child_id} recipient={r.recipient} className={view.data!.class_name} />)}
              </div>
            )}
            {error && <p className="contact-error" role="alert">{error}</p>}
          </section>
        </div>
      )}
    </Modal>
  );
}
