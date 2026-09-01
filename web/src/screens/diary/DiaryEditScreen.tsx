/*
 * 日誌作成・編集画面
 * 典拠：図/画面詳細図.md「日誌作成・編集画面」(3-2)
 *
 * 他の職員が開いている場合は、その旨をヘッダ直下に出す（要件定義書「同時編集」(4-1-4)）。
 * 過去の記録を同じ画面に並べる。前回の記述を見ながら書けるようにするため。
 * 写真は3枚まで。上限に達したら追加を無効にする。
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, visibleChildren, settingNumber } from '../../api/client';
import { Field, Alert, Loading, ErrorBox, Radios, Tag } from '../../components/ui';
import { DIARY_RECORD_TYPE, DIARY_STATUS, DIARY_STATUS_CLASS } from '../../api/codes';
import { formatMD, today } from '../../api/util';
import type { DiaryRecordType } from '../../api/types';

export default function DiaryEditScreen() {
  const { user } = useSession();
  const { id } = useParams();
  const navigate = useNavigate();
  const diaryId = id ? Number(id) : null;
  const maxPhotos = settingNumber('attachment.max_count_diary', 3);

  const existing = useAsync(async () => (diaryId ? api.getDiary(user!, diaryId) : null), [diaryId]);
  const templates = useAsync(() => api.templates(), []);
  const phrases = useAsync(() => api.phrases(), []);

  const [recordType, setRecordType] = useState<DiaryRecordType>('1');
  const [childId, setChildId] = useState('');
  const [classId, setClassId] = useState<number | ''>(user!.class_id ?? '');
  const [date, setDate] = useState(today());
  const [body, setBody] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [lockToken, setLockToken] = useState<string | undefined>();
  const [heldBy, setHeldBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const children = visibleChildren(user!);
  const classesForUser = selectableClasses(user!);

  // 既存の日誌を開いたら値を流し込み、編集ロックを取りにいく
  useEffect(() => {
    const d = existing.data;
    if (!d) return;
    setRecordType(d.record_type);
    setChildId(d.child_id ?? '');
    setClassId(d.class_id ?? '');
    setDate(d.diary_date);
    setBody(d.body);
    api.attachmentsOf(d.diary_id).then((a) => setPhotos(a.map((x) => x.file_path)));
    api.acquireLock(user!, d.diary_id).then((r) => {
      if ('token' in r) { setLockToken(r.token); setHeldBy(null); }
      else setHeldBy(r.heldBy);
    });
    return () => { api.releaseLock(user!, d.diary_id); };
  }, [existing.data?.diary_id]);

  const past = useAsync(
    async () => (childId ? api.pastDiariesOf(childId, diaryId ?? undefined) : []),
    [childId, diaryId],
  );

  const applyTemplate = (templateId: number) => {
    const t = templates.data?.find((x) => x.diary_template_id === templateId);
    if (!t) return;
    setRecordType(t.record_type);
    setBody(t.body);
  };

  const save = async (status: '1' | '2') => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveDiary(user!, {
        diary_id: diaryId ?? undefined, record_type: recordType,
        child_id: needsChild ? childId : null,
        class_id: classId === '' ? null : classId,
        diary_date: date, body, lock_token: lockToken,
      }, status);
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

  if (existing.loading) return <Loading />;
  if (existing.error) return <ErrorBox text={existing.error} />;

  return (
    <div>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/diary">&lt; 日誌一覧へ</Link>
        <h1>{diaryId ? '日誌の編集' : '日誌の作成'}</h1>
        <div className="spacer" />
        {d && <Tag label={`状態：${DIARY_STATUS[d.status]}`} className={DIARY_STATUS_CLASS[d.status]} />}
      </div>

      {/* 他の職員が開いている場合は、その旨をヘッダ直下に出す（画面詳細図 3-2） */}
      {heldBy && (
        <div style={{ marginBottom: 16 }}>
          <Alert>
            {heldBy}さんが編集中です。保存できません。ロックの解除は管理者が行えます。
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
          </Alert>
        </div>
      )}
      {error && <div style={{ marginBottom: 16 }}><ErrorBox text={error} /></div>}

      <div className="grid12">
        <section className="card col-8">
          <div className="stack">
            <Field label="記録種別" required>
              <Radios name="recordType" value={recordType}
                options={(Object.keys(DIARY_RECORD_TYPE) as DiaryRecordType[])
                  .map((k) => ({ value: k, label: DIARY_RECORD_TYPE[k] }))}
                onChange={setRecordType} />
            </Field>

            <div className="row">
              {needsChild && (
                <Field label="対象の園児" required style={{ flex: 1 }}>
                  <select value={childId} onChange={(e) => setChildId(e.target.value)} disabled={readOnly}>
                    <option value="">選んでください</option>
                    {children.map((c) => <option key={c.child_id} value={c.child_id}>{c.child_name}</option>)}
                  </select>
                </Field>
              )}
              <Field label="対象のクラス" style={{ flex: 1 }}>
                <select value={classId} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : '')}
                  disabled={readOnly}>
                  <option value="">指定しない</option>
                  {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
                </select>
              </Field>
              <Field label="記録日" required>
                <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} disabled={readOnly} />
              </Field>
            </div>

            <div className="row">
              <select defaultValue="" onChange={(e) => { if (e.target.value) applyTemplate(Number(e.target.value)); }}
                disabled={readOnly} style={{ maxWidth: 240 }}>
                <option value="">雛形を呼び出す</option>
                {templates.data?.map((t) => (
                  <option key={t.diary_template_id} value={t.diary_template_id}>{t.template_name}</option>
                ))}
              </select>
              <select defaultValue="" onChange={(e) => { if (e.target.value) { setBody((b) => `${b}${e.target.value}\n`); e.target.value = ''; } }}
                disabled={readOnly} style={{ maxWidth: 320 }}>
                <option value="">定型文を入れる</option>
                {phrases.data?.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            <Field label="本文" required>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={readOnly}
                style={{ minHeight: 280 }} />
            </Field>

            {/* 写真は3枚まで。上限に達したら追加を無効にする（画面詳細図 3-2） */}
            <Field label={`写真（1〜${maxPhotos}枚）`}>
              <div className="row">
                {photos.map((p, i) => (
                  <span key={p} className="tag tag-plain" style={{ padding: '10px 14px' }}>
                    {i + 1}
                    <button className="btn-sm btn-quiet" onClick={() => setPhotos(photos.filter((x) => x !== p))}
                      disabled={readOnly}>削除</button>
                  </span>
                ))}
                <button onClick={() => setPhotos([...photos, `demo/photo-${Date.now()}`])}
                  disabled={readOnly || photos.length >= maxPhotos}>
                  ＋ 追加
                </button>
              </div>
              {photos.length >= maxPhotos && <div className="muted">上限の{maxPhotos}枚に達しました。</div>}
            </Field>

            <div className="row-end">
              <button onClick={() => save('1')} disabled={busy || readOnly || !!heldBy}>下書き保存</button>
              <button className="btn-primary" onClick={() => navigate('/staff/diary/confirm', {
                state: { recordType, childId: needsChild ? childId : null, classId: classId === '' ? null : classId,
                         date, body, diaryId, lockToken, photos },
              })} disabled={busy || readOnly || !!heldBy || !body.trim()}>
                確認へ進む
              </button>
            </div>
          </div>
        </section>

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
