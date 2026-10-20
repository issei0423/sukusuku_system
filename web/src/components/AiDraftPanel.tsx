/*
 * AI の下書き（部品）
 * 典拠：詳細設計書「画面」(8-9)・「キーが無い・無効・有効にしていないときの画面」(8-8)・「経路」(8-2)、
 *      基本設計書「文章の下書き（AI）」(4-11)「処理の流れ」「使えないとき（AI 無しで動くこと）」
 *
 * 入力の順番「選ぶ → 定型文 → AI の下書き → 手で直す」の任意の層。GET /api/ai/status が真のときだけ出す
 * （キーが無い・園が有効にしていない・宛先の子の保護者が断った・まだ同意していないときは何も出さない。理由も出さない）。
 * 下書きは入力欄に入るだけで、送るのは職員が「送る」を押したとき（宛先の表示と他児の名前の照合を通る）。まとめて送る操作は置かない。
 *
 * | 段階 | 表示 |
 * | 閉じている | 「AI で下書き」（園からだけ）、「言い換え」「続き」（欄に文があるときだけ押せる） |
 * | 開いた（AI で下書き） | メモの欄（500文字、任意）と「体温や体の具合は書かずに…」、「下書きを作る」 |
 * | 作っている | 「下書きを作っています（10秒ほどかかることがあります）」。入力欄はそのまま書ける。二度押しは止める |
 * | できた | 欄が空なら下書きをそのまま入れる。文があれば置き換えずに候補のカードで出し、「この文を使う」で入れる |
 * | 失敗 | 応答の文（「いまは下書きを作れません。そのまま書いて送れます。」など）をここに出す。入力欄の文は残す |
 */
import { useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import type { AiField, AiPurpose } from '../api/shapes';
import { useSession } from '../session';
import { AI_TEXT } from '../messages';

/** メモの上限（詳細設計書「経路」(8-2)） */
const MEMO_MAX = 500;
/** 【仮置き】「続き」を押せるのは、欄の上限まで少なくともこの文字数の空きがあるとき（web/仮置き値.md） */
const CONTINUE_MIN_ROOM = 10;

type Result = { purpose: AiPurpose; drafts: string[]; replaced: boolean; inserted: boolean };

export default function AiDraftPanel({ childId, date, field, max, text, disabled, allowDraft, onUse }: {
  childId: string;
  date: string;
  field: AiField;
  /** 欄の上限の文字数 */
  max: number;
  /** いまの入力欄の文 */
  text: string;
  /** 送っている間など、押せないとき */
  disabled?: boolean;
  /** 「AI で下書き」（園からのひとことの下書き）を出すか。活動のひとことは言い換え・続きだけ */
  allowDraft: boolean;
  /** 入力欄に入れる。mode は replace（入れ替える）か append（続きを足す） */
  onUse: (value: string, mode: 'replace' | 'append') => void;
}) {
  const { user } = useSession();
  const memoId = useId();
  const [available, setAvailable] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [memo, setMemo] = useState('');
  const [making, setMaking] = useState<AiPurpose | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 使えるかを読む。読めないときは出さない（AI が無くても届けられる）
  const readStatus = () => api.aiStatus(user!, { child_id: childId })
    .then((r) => setAvailable(r.available)).catch(() => setAvailable(false));
  useEffect(() => {
    let alive = true;
    api.aiStatus(user!, { child_id: childId })
      .then((r) => { if (alive) setAvailable(r.available); })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, [user, childId]);

  if (!available) return null;
  const hasText = text.trim() !== '';
  const roomForMore = max - [...text.trim()].length >= CONTINUE_MIN_ROOM;

  const make = async (purpose: AiPurpose) => {
    if (making) return;
    setMaking(purpose); setError(null); setResult(null);
    try {
      const res = await api.aiDrafts(user!, {
        purpose, child_id: childId, date, field,
        ...(purpose === 'facility_note' ? { memo: memo.trim() } : { text: text.trim() }),
      });
      // 欄が空なら下書きをそのまま入れる。文があれば置き換えずに候補として出す
      const insertNow = purpose === 'facility_note' && !hasText && res.drafts.length === 1;
      if (insertNow) onUse(res.drafts[0], 'replace');
      setResult({ purpose, drafts: res.drafts, replaced: res.replaced_other_names, inserted: insertNow });
      if (purpose === 'facility_note') setMemoOpen(false);
    } catch (e) {
      setError((e as Error).message);
      // キーが無効と分かったときなどは、読み直すとボタンが消える
      void readStatus();
    } finally {
      setMaking(null);
    }
  };

  const use = (d: string) => {
    onUse(d, result?.purpose === 'continue' ? 'append' : 'replace');
    setResult((r) => (r ? { ...r, drafts: [], inserted: true } : r));
  };

  return (
    <div className="ai-draft">
      <div className="ai-draft-buttons" role="group" aria-label="AI の下書き">
        {allowDraft && (
          <button type="button" className="contact-pick" aria-expanded={memoOpen} disabled={disabled || making !== null}
            onClick={() => { setMemoOpen((o) => !o); setError(null); }}>{AI_TEXT.draftButton}</button>
        )}
        <button type="button" className="contact-pick" disabled={disabled || making !== null || !hasText}
          onClick={() => void make('rephrase')}>{AI_TEXT.rephraseButton}</button>
        <button type="button" className="contact-pick" disabled={disabled || making !== null || !hasText || !roomForMore}
          onClick={() => void make('continue')}>{AI_TEXT.continueButton}</button>
      </div>

      {memoOpen && (
        <div className="ai-draft-memo">
          {/* 【仮置き】メモの欄の見出し（web/仮置き値.md） */}
          <label htmlFor={memoId}>メモ（なくてもよい。箇条書き・話し言葉でよい）</label>
          <p className="muted" id={`${memoId}-note`}>{AI_TEXT.memoNote}</p>
          <textarea id={memoId} aria-describedby={`${memoId}-note`} value={memo} maxLength={MEMO_MAX}
            onChange={(e) => setMemo(e.target.value)} />
          <div className="contact-composer-actions">
            <button type="button" className="btn-primary" onClick={() => void make('facility_note')} disabled={making !== null}
              aria-busy={making === 'facility_note'}>{AI_TEXT.makeDraft}</button>
            <button type="button" onClick={() => setMemoOpen(false)} disabled={making !== null}>閉じる</button>
          </div>
        </div>
      )}

      {making && <p className="ai-draft-status" role="status">{AI_TEXT.making}</p>}
      {error && <p className="contact-error" role="alert">{error}</p>}

      {result && (
        <div className="ai-draft-result" role="status">
          {result.drafts.length > 0 && !result.inserted && (
            <ul className="ai-draft-candidates">
              {result.drafts.map((d, i) => (
                <li key={i} className="ai-draft-card">
                  <p>{result.purpose === 'continue' ? `…${d}` : d}</p>
                  <button type="button" onClick={() => use(d)} disabled={disabled}>{AI_TEXT.useThis}</button>
                </li>
              ))}
            </ul>
          )}
          <p className="ai-draft-note">{AI_TEXT.checkBeforeSend}</p>
          {result.replaced && <p className="ai-draft-note">{AI_TEXT.replacedOthers}</p>}
          <button type="button" className="btn-quiet" onClick={() => setResult(null)}>閉じる</button>
        </div>
      )}
    </div>
  );
}
