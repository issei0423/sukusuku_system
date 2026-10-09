/*
 * CSV一括登録画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「ファイルの選択、取込内容とエラー行の確認」
 *      基本設計書.md「CSV一括登録」(4-4)
 *
 * エラー行があるときは1件も取り込まない。中途半端な状態を作らないため。
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Empty, Field, Alert } from '../../components/ui';
import { notify } from '../../components/feedback';
import type { CsvRow } from '../../api/client';

const SAMPLE = [
  '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱',
  'C101,青木 陽菜,あおき ひな,2025-04-10,2,さくら組,36.6',
  'C102,岡田 湊斗,おかだ みなと,2025-02-14,1,さくら組,36.7',
].join('\n');

export default function ChildCsvScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ header: string[]; rows: CsvRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readFile = async (file: File) => {
    const content = await file.text();
    setText(content);
    setParsed(await api.parseChildCsv(content));
  };

  // 取込内容の検証はサーバ側でも行う。画面の判定だけに頼らない
  const check = async () => {
    setError(null);
    try {
      setParsed(await api.parseChildCsv(text));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doImport = async () => {
    if (!parsed) return;
    setBusy(true); setError(null);
    try {
      const n = await api.importChildCsv(user!, parsed.rows, text);
      notify(`${n} 件を登録しました`);
      navigate('/staff/children');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const errorCount = parsed?.rows.filter((r) => r.error).length ?? 0;

  return (
    <div style={{ maxWidth: 940 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/children">&lt; 園児一覧へ</Link>
        <h1>CSV一括登録</h1>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}

      <section className="card">
        <div className="stack">
          <Field label="ファイルを選ぶ">
            <input type="file" accept=".csv,text/csv"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
          </Field>
          <Field label="または内容を貼り付ける">
            <textarea value={text} onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE} style={{ fontFamily: 'monospace', minHeight: 140 }} />
          </Field>
          <div className="row">
            <button onClick={check} disabled={!text.trim()}>取込内容を確認する</button>
            <button className="btn-quiet btn-sm" onClick={() => { setText(SAMPLE); setParsed(null); }}>
              サンプルを入れる
            </button>
          </div>
          <div className="muted">
            列の並び：園児ID, 氏名, 氏名かな, 生年月日（YYYY-MM-DD）, 性別（1:男 2:女 9:未回答）, クラス名, 平熱
          </div>
        </div>
      </section>

      {parsed && (
        <section className="card">
          <div className="page-head">
            <h2>取込内容</h2>
            <div className="spacer" />
            <span className={errorCount > 0 ? 'tag tag-returned' : 'tag tag-approved'}>
              {errorCount > 0 ? `エラー ${errorCount} 行` : 'エラーなし'}
            </span>
          </div>

          {parsed.rows.length === 0 && <Empty text="取り込む行がありません。" />}
          {parsed.rows.length > 0 && (
            <table className="list">
              <thead>
                <tr><th scope="col">行</th>{parsed.header.map((h) => <th scope="col" key={h}>{h}</th>)}<th scope="col">判定</th></tr>
              </thead>
              <tbody>
                {parsed.rows.map((r) => (
                  <tr key={r.line} style={r.error ? { background: 'var(--c-alert-soft)' } : undefined}>
                    <td className="num">{r.line}</td>
                    {parsed.header.map((_, i) => <td key={i}>{r.values[i] ?? ''}</td>)}
                    <td>
                      {r.error ? <span style={{ color: 'var(--c-alert)', fontWeight: 700 }}>{r.error}</span> : 'OK'}
                      {/* 取り込みは妨げないが、確かめてほしいこと（範囲の外の平熱など） */}
                      {!r.error && r.warning && <div className="muted">確認：{r.warning}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {errorCount > 0 && (
            <div style={{ marginTop: 12 }}>
              <Alert>
                エラー行があるため取り込めません。1件も登録せずに止めています。
                中途半端に登録された状態を作らないためです。
              </Alert>
            </div>
          )}

          <div className="row-end" style={{ marginTop: 12 }}>
            <button className="btn-primary" onClick={doImport}
              disabled={busy || errorCount > 0 || parsed.rows.length === 0}>
              {parsed.rows.length} 件を登録する
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
