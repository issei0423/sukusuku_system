/*
 * 配布物管理画面（職員・タブレット／PC）
 * 典拠：図/画面詳細図.md「配布物管理画面」
 *
 * 掲載と取り下げは管理者だけが行う。園全体への発信は園としての意思表示であり、
 * 園チャットへ投稿できるのが管理者だけであるのと同じ扱いにする。一般は閲覧のみ。
 * 掲載すると、園全体向けは園チャット、クラス向けはそのクラスグループへ知らせが流れる。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, selectableClasses, settingNumber, settingText } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal, Tag } from '../../components/ui';
import HandoutViewer from '../../components/HandoutViewer';
import { notify } from '../../components/feedback';
import { HANDOUT_TYPE } from '../../api/codes';
import { formatFileSize, formatMonth, formatMDHM, today } from '../../api/util';
import type { Handout } from '../../api/types';

export default function StaffHandoutsScreen() {
  const { user } = useSession();
  const isAdmin = user!.role === '1';
  const classesForUser = selectableClasses(user!);

  const [type, setType] = useState('');
  const [tick, setTick] = useState(0);
  const { data, error: loadError, loading } = useAsync(() => api.handouts(user!, { type }), [type, tick]);

  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Handout | null>(null);
  const [withdrawing, setWithdrawing] = useState<Handout | null>(null);

  // 掲載の入力
  const [formOpen, setFormOpen] = useState(false);
  const [fType, setFType] = useState('1');
  const [fTitle, setFTitle] = useState('');
  const [fMonth, setFMonth] = useState(today().slice(0, 7));
  const [fClass, setFClass] = useState<number | ''>('');
  const [file, setFile] = useState<{ name: string; type: string; size: number } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = settingText('handout.allowed_types', 'application/pdf,image/jpeg,image/png').split(',');
  const maxMB = settingNumber('attachment.max_size_mb', 10);

  const openForm = () => {
    setFType('1'); setFTitle(''); setFMonth(today().slice(0, 7)); setFClass(''); setFile(null);
    setFormError(null); setFormOpen(true);
  };

  const post = async () => {
    setFormError(null);
    if (!file) { setFormError('ファイルを選んでください'); return; }
    setBusy(true);
    try {
      await api.postHandout(user!, {
        handout_type: fType, title: fTitle, target_month: fMonth, class_id: fClass === '' ? null : fClass,
        file_name: file.name, file_type: file.type, file_size: file.size,
      });
      setFormOpen(false);
      setTick((n) => n + 1);
      // 操作が通ったことを画面の下端に出す（図/画面詳細図.md「全画面に共通する規定」(0-2)「完了の表示」。GitHub Issue #175 の 5）
      notify(`「${fTitle.trim()}」を掲載しました`);
    } catch (e) { setFormError((e as Error).message); } finally { setBusy(false); }
  };

  const withdraw = async () => {
    if (!withdrawing) return;
    setError(null);
    try {
      await api.withdrawHandout(user!, withdrawing.handout_id);
      setWithdrawing(null);
      setTick((n) => n + 1);
      notify(`「${withdrawing.title}」を取り下げました`);
    } catch (e) { setError((e as Error).message); setWithdrawing(null); }
  };

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/chat">&lt; チャットへ</Link>
        <h1>園からの配布物</h1>
        <div className="spacer" />
        {isAdmin && <button className="btn-primary" onClick={openForm}>配布物を掲載する</button>}
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        <div className="filterbar">
          <Field label="種類">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">すべて</option>
              {Object.entries(HANDOUT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <section className="card">
        {loading && <Loading />}
        {loadError && <ErrorBox text={loadError} />}
        {data?.length === 0 && <Empty text="掲載中の配布物はありません。" />}
        {data && data.length > 0 && (
          <table className="list">
            <thead>
              <tr><th scope="col">対象の月</th><th scope="col">種類</th><th scope="col">題名</th><th scope="col">対象</th><th scope="col">ファイル</th><th scope="col">掲載</th><th scope="col">操作</th></tr>
            </thead>
            <tbody>
              {data.map((h) => (
                <tr key={h.handout_id}>
                  <td className="nowrap">{formatMonth(h.target_month)}</td>
                  <td className="nowrap"><Tag label={HANDOUT_TYPE[h.handout_type] ?? 'その他'} className="tag-applied" /></td>
                  <td>{h.title}</td>
                  <td className="nowrap">{h.class_name ?? '園全体'}</td>
                  <td className="nowrap">
                    {h.file_type === 'application/pdf' ? 'PDF' : '画像'}・{formatFileSize(h.file_size)}
                  </td>
                  <td className="nowrap">{formatMDHM(h.posted_at)} {h.posted_staff_name}</td>
                  <td className="nowrap">
                    <button className="btn-sm" onClick={() => setOpened(h)}>開く</button>
                    {isAdmin && <> <button className="btn-sm" onClick={() => setWithdrawing(h)}>取り下げ</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          園だより・献立表など、保護者があとから見返すものを掲載します。保護者は「園からの配布物」から、月ごとに見られます。
          <br />
          園全体向けはすべての保護者に、クラス向けはそのクラスに在籍する園児の保護者にだけ表示されます。
          {!isAdmin && <><br />掲載と取り下げは管理者が行います。</>}
        </div>
      </section>

      {formOpen && (
        <Modal title="配布物の掲載" onClose={() => setFormOpen(false)}
          footer={<>
            <button onClick={() => setFormOpen(false)} disabled={busy}>やめる</button>
            <button className="btn-primary" onClick={post} disabled={busy || !fTitle.trim() || !file}>掲載する</button>
          </>}>
          <div className="stack">
            {formError && <Alert>{formError}</Alert>}
            <Field label="種類" required>
              <select value={fType} onChange={(e) => setFType(e.target.value)}>
                {Object.entries(HANDOUT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="題名" required>
              <input type="text" value={fTitle} maxLength={50} placeholder="例：10月の献立表"
                onChange={(e) => setFTitle(e.target.value)} />
              <div className="muted">残り {50 - [...fTitle].length} 文字</div>
            </Field>
            <Field label="対象の月" required>
              <input type="month" value={fMonth} onChange={(e) => setFMonth(e.target.value)} style={{ maxWidth: 200 }} />
            </Field>
            <Field label="対象" required>
              <select value={fClass} onChange={(e) => setFClass(e.target.value ? Number(e.target.value) : '')}>
                <option value="">園全体</option>
                {classesForUser.map((c) => <option key={c.class_id} value={c.class_id}>{c.class_name}</option>)}
              </select>
            </Field>
            <Field label="ファイル" required>
              <input type="file" accept={allowed.join(',')} aria-label="ファイル"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setFile(f ? { name: f.name, type: f.type, size: f.size } : null);
                }} />
              <div className="muted">PDF・JPEG・PNG、{maxMB}MB まで</div>
            </Field>
            {/* 誰に届くかを、掲載する前に示す */}
            <Alert soft>
              {fClass === ''
                ? 'すべての保護者に表示され、園チャットへ掲載の知らせが流れます。'
                : `${classesForUser.find((c) => c.class_id === fClass)?.class_name} の保護者に表示され、クラスグループへ掲載の知らせが流れます。`}
            </Alert>
          </div>
        </Modal>
      )}

      {withdrawing && (
        <Modal title="配布物の取り下げ" onClose={() => setWithdrawing(null)}
          footer={<>
            <button onClick={() => setWithdrawing(null)}>やめる</button>
            <button className="btn-primary" onClick={withdraw}>取り下げる</button>
          </>}>
          <div className="stack">
            <div>「{withdrawing.title}」を取り下げます。</div>
            <div className="muted">
              保護者の一覧から消え、チャットに流れた掲載の知らせも取り消されます。
              すでに開いて読んだ保護者がいても、読んだこと自体は取り消せません。
            </div>
          </div>
        </Modal>
      )}

      {opened && <HandoutViewer handout={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}
