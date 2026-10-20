/*
 * 日誌作成・編集画面
 * 典拠：図/画面詳細図.md「日誌作成・編集画面」(3-2)
 *
 * 他の職員が開いている場合は、その旨をヘッダ直下に出す（要件定義書「同時編集」(4-1-4)）。
 * 過去の記録を同じ画面に並べる。前回の記述を見ながら書けるようにするため。
 * 写真は3枚まで。上限に達したら追加を無効にする。写真は、下書き保存・申請のときに日誌と一緒に保存する（GitHub Issue #175 の 2）。
 * 編集できない状態（申請中・承認済み、ほかの職員が編集中）では、内容を変える部品を動かさない（同 4）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, visibleChildren, settingNumber, staffName } from '../../api/client';
import type { DiaryAttachmentInput } from '../../api/client';
import { Field, Alert, Loading, ErrorBox, Radios, Tag } from '../../components/ui';
import { ConfirmDialog, notify } from '../../components/feedback';
import { DIARY_RECORD_TYPE, DIARY_STATUS, DIARY_STATUS_CLASS } from '../../api/codes';
import { formatMD, formatMDHM, today, now, plusMinutes } from '../../api/util';
import type { DiaryRecordType } from '../../api/types';
import { acquireDiaryLock, releaseDiaryLock, releaseDiaryLockNow, markDiaryLockHandOver, LOCK_TOUCH_MS } from './diaryLock';

// 本文の上限（基本設計書「入力項目の制約値」(4-9)）
const BODY_MAX = 2000;

/** 確認画面とのあいだで受け渡す、入力中の内容 */
interface DiaryDraft {
  recordType: DiaryRecordType;
  childId: string | null;
  classId: number | null;
  date: string;
  body: string;
  photos: DiaryAttachmentInput[];
}

export default function DiaryEditScreen() {
  const { user } = useSession();
  const { id } = useParams();
  const navigate = useNavigate();
  const diaryId = id ? Number(id) : null;
  const maxPhotos = settingNumber('attachment.max_count_diary', 3);

  const existing = useAsync(async () => (diaryId ? api.getDiary(user!, diaryId) : null), [diaryId]);
  const templates = useAsync(() => api.templates(), []);
  const phrases = useAsync(() => api.phrases(), []);

  /*
   * 確認画面の「戻る」から来たときは、入力していた内容を受け取る（画面詳細図「日誌確認画面」(3-3)）。
   * 受け取らないと、まだ保存していない日誌の入力が、戻っただけで消える
   */
  const draft = (useLocation().state as { draft?: DiaryDraft } | null)?.draft;
  const [recordType, setRecordType] = useState<DiaryRecordType>(draft?.recordType ?? '1');
  const [childId, setChildId] = useState(draft?.childId ?? '');
  const [classId, setClassId] = useState<number | ''>(draft ? (draft.classId ?? '') : (user!.class_id ?? ''));
  const [date, setDate] = useState(draft?.date ?? today());
  const [body, setBody] = useState(draft?.body ?? '');
  const [photos, setPhotos] = useState<DiaryAttachmentInput[]>(draft?.photos ?? []);
  /*
   * 保存していない入力があるか。一覧へ戻る前に確かめるために持つ（画面詳細図「日誌作成・編集画面」(3-2) 項目1
   * 「未保存の内容がある場合は確認する」）。本文の欄だけでなく、内容を変える操作（記録種別・園児・クラス・記録日・
   * 雛形・定型文・写真）のすべてで立て、保存できたら下ろす。保存のあとも立てたままだと、保存した直後に
   * 「保存していない内容があります」が出ていた。定型文を選んでも立てずに、黙って離れていた（GitHub Issue #175 の 3）
   */
  const [dirty, setDirty] = useState(!!draft);
  const [leaving, setLeaving] = useState(false);
  const [lockToken, setLockToken] = useState<string | undefined>();
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  // いま持っているロックの識別子。画面を離れるときの解除に使う（描画を待たずに読めるよう ref にも持つ）
  const lockRef = useRef<string | undefined>(undefined);
  // 確認画面へ進むときは、ロックを確認画面へ引き継ぐ（外さない。./diaryLock.ts）
  const handOverRef = useRef(false);
  const lastTouchRef = useRef(0);
  // 「＋ 追加」で足す仮の写真の通し番号。時計が同じ値を返しても、写真どうしの名前をぶつけない
  const photoSeqRef = useRef(0);

  const children = visibleChildren(user!);
  const classesForUser = selectableClasses(user!);

  // 既存の日誌を開いたら値を流し込み、編集ロックを取りにいく
  useEffect(() => {
    const d = existing.data;
    if (!d) return;
    // 確認画面から戻ったときは、保存済みの値で上書きしない
    if (!draft) {
      setRecordType(d.record_type);
      setChildId(d.child_id ?? '');
      setClassId(d.class_id ?? '');
      /*
       * 書いたあとに園児のクラスが変わった、またはクラスの空いた（以前の版の）個人日誌は、直せるうちは
       * 園児のいまの在籍クラスを入れる。担当外のクラスのままでは保存を断られ、一般はクラスを選び直せない（GitHub Issue #174）
       */
      if (d.child_id && d.status !== '2' && d.status !== '3'
        && (d.class_id == null || !classesForUser.some((c) => c.class_id === d.class_id))) {
        api.classOf(user!, d.child_id).then((c) => { if (c != null) setClassId(c); }, () => {});
      }
      setDate(d.diary_date);
      setBody(d.body);
      api.attachmentsOf(user!, d.diary_id)
        .then((a) => setPhotos(a.map((x) => ({ file_path: x.file_path, file_type: x.file_type }))));
    }
    // 申請中・承認済みは編集できない。読むだけの人にロックを取らせない（GitHub Issue #110）
    // ロックは取らないが、ほかの職員が開いていればその旨は出す（画面詳細図 3-2）
    if (d.status === '2' || d.status === '3') {
      api.lockOf(user!, d.diary_id).then((l) => {
        const idle = settingNumber('ui.diary_lock_minutes', 15);
        if (l && l.locked_staff_id !== user!.staff_id && plusMinutes(l.last_active_at, idle) > now()) {
          setHeldBy(l.staff_name);
        }
      });
      return;
    }
    let active = true;
    acquireDiaryLock(user!, d.diary_id).then((r) => {
      if (!active) {
        // 取りにいっている間に画面を離れた。取れたロックは外す
        if ('token' in r) void releaseDiaryLock(user!, d.diary_id, r.token);
        return;
      }
      // 取ったこと自体が操作にあたる（サーバは取得の時刻を最終操作時刻にする）。続けて知らせを送らない
      if ('token' in r) { lockRef.current = r.token; lastTouchRef.current = Date.now(); setLockToken(r.token); setHeldBy(null); }
      else setHeldBy(r.heldBy);
    }).catch((e) => { if (active) setError((e as Error).message); });
    // 画面を移るときだけでなく、タブを閉じる・読み込み直すときにもロックを外す。解除は識別子を添えて送る
    const onPageHide = () => {
      if (lockRef.current) void releaseDiaryLockNow(user!, d.diary_id, lockRef.current);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      active = false;
      window.removeEventListener('pagehide', onPageHide);
      const token = lockRef.current;
      lockRef.current = undefined;
      // 確認画面へ進むときは外さない。確認画面が、申請する（サーバが外す）か離れるときに外す（GitHub Issue #166 の 1）
      if (token && !handOverRef.current) void releaseDiaryLock(user!, d.diary_id, token);
    };
  }, [existing.data?.diary_id]);

  /*
   * 編集画面での操作（入力の変化）をサーバへ知らせ、無操作の判定を最後の操作から数えさせる
   * （基本設計書「編集ロックの解除」(4-5)、5-4 last_active_at。GitHub Issue #166 の 3）。
   * 知らせないと、書き続けていても取った時刻から無操作の時間で切れ、ほかの職員に取られる。
   * ロックが外れていたら（強制解除・無操作で引き取られた）、その場で知らせる。入力中の内容は画面に残す
   */
  useEffect(() => {
    if (!diaryId || !lockToken) return;
    const t = Date.now();
    if (t - lastTouchRef.current < LOCK_TOUCH_MS) return;
    lastTouchRef.current = t;
    api.touchLock(user!, diaryId, lockToken).catch((e) => setError((e as Error).message));
  }, [user, diaryId, lockToken, body, recordType, childId, classId, date, photos]);

  // 管理者による強制解除（基本設計書「編集ロックの解除」(4-5)）。解除したあと、自分がロックを取り直す
  const forceUnlock = async () => {
    if (!diaryId) return;
    setBusy(true); setError(null);
    try {
      await api.releaseLock(user!, diaryId, true);
      // 編集できない状態（申請中・承認済み）の日誌では、解除だけを行い、ロックは取り直さない
      if (existing.data && (existing.data.status === '2' || existing.data.status === '3')) {
        setHeldBy(null);
        notify('編集ロックを解除しました');
        return;
      }
      const r = await acquireDiaryLock(user!, diaryId);
      if ('token' in r) {
        lockRef.current = r.token; lastTouchRef.current = Date.now();
        setLockToken(r.token); setHeldBy(null); notify('編集ロックを解除しました');
      }
      else setHeldBy(r.heldBy);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setUnlocking(false); }
  };

  const past = useAsync(
    async () => (childId ? api.pastDiariesOf(user!, childId, diaryId ?? undefined) : []),
    [childId, diaryId],
  );

  /*
   * 雛形は、いまの記録種別のものだけを並べる。選んでも記録種別は変えない（画面詳細図「日誌作成・編集画面」(3-2)
   * 項目7「記録種別に応じた雛形を本文へ入れる」）。すべての雛形を並べ、選ぶと記録種別が黙って変わっていた（GitHub Issue #178 の 2）
   */
  const templatesForType = templates.data?.filter((t) => t.record_type === recordType) ?? [];

  const applyTemplate = (templateId: number) => {
    const t = templatesForType.find((x) => x.diary_template_id === templateId);
    if (!t) return;
    // 書きかけを失わせない。本文が空なら入れ、入力済みなら末尾へ足す（画面詳細図「日誌作成・編集画面」(3-2)）
    setBody(body.trim() ? `${body.trimEnd()}\n\n${t.body}` : t.body);
    setDirty(true);
  };

  /*
   * 定型文は、本文の末尾へ足す（基本設計書「日誌の作成から保護者への共有」(4-5)、画面詳細図 3-2 項目8）。
   * 書いてある本文の後ろは、行を改めてから足す（【仮置き】web/仮置き値.md「日誌作成・編集画面の動き」）。
   * 選んだ値は呼び出しの前に受け取る。欄を空へ戻したあとに読むと空になり、改行しか入らなかった（GitHub Issue #175 の 1）
   */
  const addPhrase = (phrase: string) => {
    setBody((b) => (b === '' || b.endsWith('\n') ? `${b}${phrase}` : `${b}\n${phrase}`));
    setDirty(true);
  };

  // 「＋ 追加」は仮の写真を足す。ファイルを選ぶ部品は置かない（図/画面詳細図.md「モックアップでは実装しないもの」(11-1)）。
  // 実体は持たず、名前と形式だけを持つ（web/仮置き値.md 7「添付ファイルの実体」）
  const addPhoto = () => {
    photoSeqRef.current += 1;
    setPhotos([...photos, { file_path: `demo/photo-${Date.now()}-${photoSeqRef.current}`, file_type: 'image/jpeg' }]);
    setDirty(true);
  };
  const removePhoto = (path: string) => {
    setPhotos(photos.filter((x) => x.file_path !== path));
    setDirty(true);
  };

  const save = async (status: '1' | '2') => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveDiary(user!, {
        diary_id: diaryId ?? undefined, record_type: recordType,
        child_id: needsChild ? childId : null,
        class_id: classId === '' ? null : classId,
        diary_date: date, body, lock_token: lockToken, attachments: photos,
      }, status);
      // 保存できたので、保存していない内容は無い（GitHub Issue #175 の 3）
      setDirty(false);
      notify(status === '2' ? '日誌を申請しました' : '下書きを保存しました');
      navigate(status === '2' ? '/staff/diary' : `/staff/diary/${saved.diary_id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsChild = recordType === '1' || recordType === '4';
  const d = existing.data;
  const readOnly = !!d && (d.status === '2' || d.status === '3');
  // 内容を変えられない状態。申請中・承認済みの日誌と、ほかの職員が編集中の日誌（画面詳細図 3-2 項目17、
  // 基本設計書「編集ロックの解除」(4-5)）。本文の欄だけ止めても、ほかの部品で中身が変わっていた（GitHub Issue #175 の 4）
  const locked = readOnly || !!heldBy;
  const lockPending = !!diaryId && !lockToken && !heldBy;

  /*
   * 園児を選んだら、その園児の在籍クラスを対象のクラスに入れる。個人日誌・ヒヤリハットの対象のクラスは、
   * 対象の園児が在籍するクラスに限る（サーバが確かめる。web/仮置き値.md。GitHub Issue #174）。
   * 担当クラスを持たない管理者が、園児ごとにクラスを選び直さなくて済むようにする。
   * 引けなかったときは何もしない（クラスは手で選べ、保存のときにサーバが確かめる）
   */
  const chooseChild = (id: string) => {
    setChildId(id);
    setDirty(true);
    if (!id) return;
    api.classOf(user!, id).then((c) => { if (c != null) setClassId(c); }, () => {});
  };

  /*
   * 確認へ進む前に、記録日を確かめる。記録日は当日まで（図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目6）。
   * 欄の max だけでは、打ち込んだ先の日付を止められない（GitHub Issue #174）。サーバとモックも同じ規則で断る
   */
  const goConfirm = () => {
    if (!date) { setError('記録日を入力してください'); return; }
    if (date > today()) { setError('記録日に未来日は指定できません（当日まで）'); return; }
    // ロックは確認画面へ引き継ぐ。確認画面にいる間に、ほかの職員が開いて直せないようにする（GitHub Issue #166 の 1）。
    // 記録日で止めたときは編集画面に残るので、引き継ぎの印は進むと決まってから付ける
    handOverRef.current = true;
    if (diaryId && lockToken) markDiaryLockHandOver(diaryId, lockToken);
    navigate('/staff/diary/confirm', {
      state: { recordType, childId: needsChild ? childId : null, classId: classId === '' ? null : classId,
               date, body, diaryId, lockToken, photos },
    });
  };

  if (existing.loading) return <Loading />;
  if (existing.error) return <ErrorBox text={existing.error} />;

  return (
    <div>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/diary"
          onClick={(e) => { if (dirty && !readOnly) { e.preventDefault(); setLeaving(true); } }}>&lt; 日誌一覧へ</Link>
        <h1>{diaryId ? '日誌の編集' : '日誌の作成'}</h1>
        <div className="spacer" />
        {d && <Tag label={`状態：${DIARY_STATUS[d.status]}`} className={DIARY_STATUS_CLASS[d.status]} />}
      </div>

      {/* 他の職員が開いている場合は、その旨をヘッダ直下に出す（画面詳細図 3-2） */}
      {heldBy && (
        <div style={{ marginBottom: 16 }}>
          <Alert>
            {heldBy}さんが編集中です。{!readOnly && '保存できません。'}
            {user!.role === '1' ? (
              <>
                {' '}{heldBy}さんが編集を終えていることを確かめたうえで、ロックを強制解除できます。
                <button className="btn-sm" style={{ marginLeft: 8 }} onClick={() => setUnlocking(true)} disabled={busy}>
                  ロックを強制解除する
                </button>
              </>
            ) : ' ロックの解除は管理者へ依頼してください。'}
          </Alert>
        </div>
      )}
      {d?.status === '4' && d.returned_reason && (
        <div style={{ marginBottom: 16 }}>
          <Alert>差し戻されています：{d.returned_reason}</Alert>
        </div>
      )}
      {readOnly && (
        <div style={{ marginBottom: 16 }}>
          <Alert soft>
            {d!.status === '2' ? '申請中のため編集できません。' : '承認済みのため編集できません。'}
            {/* 承認と共有の経緯を、操作ログを探さなくても答えられるようにする（GitHub Issue #109） */}
            {d!.status === '3' && (
              <>
                <br />
                承認：{staffName(d!.approved_staff_id)}
                {d!.approved_at && `（${formatMDHM(d!.approved_at)}）`}
                <br />
                保護者への共有：
                {d!.is_shared_to_guardian
                  ? `共有した${d!.shared_at ? `（${formatMDHM(d!.shared_at)}）` : ''}`
                  : '共有していない'}
              </>
            )}
          </Alert>
        </div>
      )}
      {error && <div style={{ marginBottom: 16 }}><ErrorBox text={error} /></div>}

      <div className="grid12">
        <section className="card col-8">
          <div className="stack">
            <Field label="記録種別" required>
              <Radios name="recordType" value={recordType} disabled={locked}
                options={(Object.keys(DIARY_RECORD_TYPE) as DiaryRecordType[])
                  .map((k) => ({ value: k, label: DIARY_RECORD_TYPE[k] }))}
                onChange={(v) => { setRecordType(v); setDirty(true); }} />
            </Field>

            <div className="row">
              {needsChild && (
                <Field label="対象の園児" required style={{ flex: 1 }}>
                  <select value={childId} onChange={(e) => chooseChild(e.target.value)} disabled={locked}>
                    <option value="">選んでください</option>
                    {children.map((c) => <option key={c.child_id} value={c.child_id}>{c.child_name}</option>)}
                  </select>
                </Field>
              )}
              {/*
                * 対象のクラスは必須。「指定しない」は置かない（図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目5
                * 「入力：必須」）。クラスの空いた日誌は、書いた本人が開けなくなったり、日誌一覧から漏れたりしていた
                * （GitHub Issue #174）。担当クラスを持たない管理者は、選ぶまで空のまま
                */}
              <Field label="対象のクラス" required style={{ flex: 1 }}>
                <select value={classId}
                  onChange={(e) => { setClassId(e.target.value ? Number(e.target.value) : ''); setDirty(true); }}
                  disabled={locked}>
                  {classId === '' && <option value="">選んでください</option>}
                  {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
                </select>
              </Field>
              <Field label="記録日" required>
                <input type="date" value={date} max={today()} onChange={(e) => { setDate(e.target.value); setDirty(true); }}
                  disabled={locked} />
              </Field>
            </div>

            {/* 選んだあとは見出しの行へ戻す（値を持たない）。同じ雛形・定型文を続けて選べるようにする */}
            <div className="row">
              <select value="" onChange={(e) => { if (e.target.value) applyTemplate(Number(e.target.value)); }}
                aria-label="雛形を呼び出す" disabled={locked} style={{ maxWidth: 240 }}>
                <option value="">雛形を呼び出す</option>
                {templatesForType.map((t) => (
                  <option key={t.diary_template_id} value={t.diary_template_id}>{t.template_name}</option>
                ))}
              </select>
              <select value="" onChange={(e) => { if (e.target.value) addPhrase(e.target.value); }}
                aria-label="定型文を入れる" disabled={locked} style={{ maxWidth: 320 }}>
                <option value="">定型文を入れる</option>
                {phrases.data?.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            <Field label="本文" required>
              <textarea value={body} onChange={(e) => { setBody(e.target.value); setDirty(true); }}
                disabled={locked} maxLength={BODY_MAX} style={{ minHeight: 280 }} />
            </Field>
            {!readOnly && <div className="muted" aria-live="polite">残り {BODY_MAX - [...body].length} 文字</div>}

            {/* 写真は3枚まで。上限に達したら追加を無効にする（画面詳細図 3-2） */}
            <Field label={`写真（1〜${maxPhotos}枚）`}>
              <div className="row">
                {photos.map((p, i) => (
                  <span key={p.file_path} className="tag tag-plain" style={{ padding: '10px 14px' }}>
                    {i + 1}
                    <button className="btn-sm btn-quiet" onClick={() => removePhoto(p.file_path)}
                      disabled={locked}>削除</button>
                  </span>
                ))}
                <button onClick={addPhoto} disabled={locked || photos.length >= maxPhotos}>
                  ＋ 追加
                </button>
              </div>
              {photos.length >= maxPhotos && <div className="muted">上限の{maxPhotos}枚に達しました。</div>}
            </Field>

            {/* 個人日誌・ヒヤリハットは園児を対象にした記録。選ぶまで先へ進めない */}
            {needsChild && !childId && !readOnly && (
              <div className="muted">対象の園児を選ぶと、確認へ進めます。</div>
            )}
            {classId === '' && !readOnly && (
              <div className="muted">対象のクラスを選ぶと、確認へ進めます。</div>
            )}

            <div className="row-end">
              {/* 既存の日誌は、ロックを取れるまで保存させない。ロックの無い保存はサーバが断る（GitHub Issue #166） */}
              <button onClick={() => save('1')} disabled={busy || readOnly || !!heldBy || lockPending}>下書き保存</button>
              <button className="btn-primary" onClick={goConfirm}
                disabled={busy || readOnly || !!heldBy || lockPending || !body.trim() || (needsChild && !childId) || classId === ''}>
                確認へ進む
              </button>
            </div>
          </div>
        </section>

        {leaving && (
          <ConfirmDialog title="保存していない内容があります" confirmLabel="保存せずに戻る" danger
            onConfirm={() => navigate('/staff/diary')} onCancel={() => setLeaving(false)}>
            <p>入力した内容を保存していません。このまま一覧へ戻ると、入力した内容は残りません。</p>
            <p className="muted">残すときは、「やめる」を押してから「下書き保存」を押してください。</p>
          </ConfirmDialog>
        )}

        {unlocking && (
          <ConfirmDialog title="編集ロックの強制解除" confirmLabel="強制解除する" danger busy={busy}
            onConfirm={forceUnlock} onCancel={() => setUnlocking(false)}>
            <p>{heldBy}さんの編集ロックを解除します。</p>
            <p className="muted">
              {heldBy}さんが保存していない内容は保存できなくなります。編集を終えていることを確かめてから実行してください。
              解除したことは操作ログに残ります。
            </p>
          </ConfirmDialog>
        )}

        {/* この園児の過去の記録。前回の記述を見ながら書けるようにする（画面詳細図 3-2） */}
        <section className="card col-4">
          <h2>この園児の過去の記録</h2>
          {!childId && <div className="muted">対象の園児を選ぶと表示します。</div>}
          {childId && past.data?.length === 0 && <div className="muted">過去の記録はありません。</div>}
          <div className="stack">
            {past.data?.slice(0, 8).map((p) => (
              <Link key={p.diary_id} className="btn btn-block" to={`/staff/diary/${p.diary_id}`}
                style={{ justifyContent: 'space-between' }}>
                <span>{formatMD(p.diary_date)} {DIARY_RECORD_TYPE[p.record_type]}</span>
                <span>開く</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
