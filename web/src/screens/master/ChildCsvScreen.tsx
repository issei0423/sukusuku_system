/*
 * CSV一括登録画面（管理者）
 * 典拠：基本設計書.md「画面の一覧」(3-2)「ファイルの選択、取込内容とエラー行の確認」
 *      基本設計書.md「CSV一括登録」(4-4)
 *
 * エラー行があるときは1件も取り込まない。中途半端な状態を作らないため。
 *
 * 確認した内容と件数を登録する（要件定義書「取込前に内容と件数を確認でき」、画面詳細図 7-3「検証と登録を
 * 2段階に分ける」）。確認したあとに貼り付けの欄を書き換えたら、確認の結果を捨て、確認し直すまで登録させない。
 * 登録には、確認したときの原文を送る（GitHub Issue #160 の 3）。
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Empty, Field, Alert } from '../../components/ui';
import { notify } from '../../components/feedback';
import type { CsvRow } from '../../api/client';
import { BackIcon, UploadIcon, ConfirmIcon } from '../../components/icons';

const SAMPLE = [
  '園児ID,氏名,氏名かな,生年月日,性別,クラス名,平熱',
  'C101,青木 陽菜,あおき ひな,2025-04-10,2,さくら組,36.6',
  'C102,岡田 湊斗,おかだ みなと,2025-02-14,1,さくら組,36.7',
].join('\n');

export default function ChildCsvScreen() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  // 確認の結果と、確認したときの原文（text）。登録はこの原文で行う
  const [parsed, setParsed] = useState<{ header: string[]; rows: CsvRow[]; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 取込内容の検証はサーバ側でも行う。画面の判定だけに頼らない
  const checkText = async (content: string) => {
    setError(null);
    setParsed(null);
    try {
      setParsed({ ...(await api.parseChildCsv(content)), text: content });
    } catch (e) {
      // 見出しの並びが違うファイルなど（GitHub Issue #160 の 2）
      setError((e as Error).message);
    }
  };

  const readFile = async (file: File) => {
    const content = await file.text();
    setText(content);
    await checkText(content);
  };

  // 書き換えたら確認の結果を捨てる。確認していない行を登録させないため
  const changeText = (v: string) => {
    setText(v);
    setParsed(null);
  };

  const doImport = async () => {
    if (!parsed) return;
    setBusy(true); setError(null);
    try {
      const n = await api.importChildCsv(user!, parsed.rows, parsed.text);
      notify(`${n}名を登録し、個人チャットを用意しました。`);
      navigate('/staff/children');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const errorCount = parsed?.rows.filter((r) => r.error).length ?? 0;

  return (
    <div style={{ maxWidth: 940 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/children"><BackIcon />園児一覧へ</Link>
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
            <textarea value={text} onChange={(e) => changeText(e.target.value)}
              placeholder={SAMPLE} style={{ fontFamily: 'monospace', minHeight: 140 }} />
          </Field>
          <div className="row">
            <button onClick={() => void checkText(text)} disabled={!text.trim()}><ConfirmIcon />取込内容を確認する</button>
            <button className="btn-quiet btn-sm" onClick={() => changeText(SAMPLE)}>
              サンプルを入れる
            </button>
          </div>
          <div className="muted">
            列の並び：園児ID, 氏名, 氏名かな, 生年月日（YYYY-MM-DD）, 性別（男・女・未回答。数字なら 1:男 2:女 9:未回答）, クラス名, 平熱
            <br />
            写真の利用同意は取り込まず、最も狭い段階（園内記録のみ）で登録します。変えるときは、園児ごとの編集の画面から行ってください。
            <br />
            アレルギーと既往歴は、この取込の対象外です。取り込んだあと、園児ごとの編集の画面から入力してください。
          </div>
        </div>
      </section>

      {parsed && (
        <section className="card">
          <div className="page-head">
            <h2>取込内容</h2>
            <div className="spacer" />
            {/* エラーのある行は警告色の札（.tag-alert）。差し戻しの色（赤紫の塗り）は日誌の差し戻しだけ（見直し 2026-10-31 の r2c-02） */}
            <span className={errorCount > 0 ? 'tag tag-alert' : 'tag tag-approved'}>
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
              <UploadIcon />{parsed.rows.length} 件を登録する
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
