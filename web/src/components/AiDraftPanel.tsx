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
 *
 * 保育日誌の作成・編集画面（詳細設計書「日誌の画面（作り直し）」(2-13 (7))）は diary を渡して使う。「AI で下書き」だけを出し
 * （言い換え・続きは出さない）、本文の見出しの行を送る。本文に文が無ければ（空、または見出しの行だけ）見出しと下書きをそのまま入れ、
 * 文があれば置き換えずに候補で示す。日誌は保護者に届かないため、添える注意は「保存してから」の文（共有を選んだ個人日誌は「送ってから」）
 */
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client';
import { focusAfter, focusedNow } from '../focusAfter';
import type { AiField, AiPurpose, AiTarget } from '../api/shapes';
import type { DiaryRecordType } from '../api/types';
import { useSession } from '../session';
import { AI_TEXT } from '../messages';
import { CloseIcon } from './icons';

/** メモの上限（詳細設計書「経路」(8-2)） */
const MEMO_MAX = 500;
/** 【仮置き】「続き」を押せるのは、欄の上限まで少なくともこの文字数の空きがあるとき（web/仮置き値.md） */
const CONTINUE_MIN_ROOM = 10;

type Result = { purpose: AiPurpose; drafts: string[]; replaced: boolean; inserted: boolean };

/** 保育日誌の下書きに渡すもの。headings は本文の見出しの名前（diaryHeadings）、hasSentence は本文に文があるか（hasDiarySentence） */
export interface AiDiaryUse {
  recordType: Exclude<DiaryRecordType, '4'>;
  classId: number;
  /** 保護者へ共有する個人日誌か */
  share: boolean;
  headings: string[];
  hasSentence: boolean;
}

export default function AiDraftPanel({ childId, date, field, max, text, disabled, allowDraft, onUse, focusAfterUse, diary }: {
  /** 個人日誌と連絡帳は園児。クラス日誌・週案月案（diary）では渡さない */
  childId?: string;
  date: string;
  field?: AiField;
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
  /** 「この文を使う」のあとにフォーカスを移す先（文を入れた入力欄）。押したカードが消えるため（GitHub Issue #213） */
  focusAfterUse?: () => HTMLElement | null;
  /** 保育日誌の下書き。渡すと「AI で下書き」だけを出す */
  diary?: AiDiaryUse;
}) {
  const { user } = useSession();
  const memoId = useId();
  const [available, setAvailable] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const [memo, setMemo] = useState('');
  const [making, setMaking] = useState<AiPurpose | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftButton = useRef<HTMLButtonElement>(null);

  // 使えるかを読む宛先。個人日誌と連絡帳は園児、クラス日誌・週案月案はクラス。宛先がまだ決まっていなければ出さない
  const target: AiTarget | null = diary && diary.recordType !== '1' ? { class_id: diary.classId } : childId ? { child_id: childId } : null;
  const targetKey = target ? (target.child_id !== undefined ? `c:${target.child_id}` : `k:${target.class_id}`) : '';
  // 使えるかを読む。読めないときは出さない（AI が無くても届けられる）
  const readStatus = () => (target ? api.aiStatus(user!, target) : Promise.resolve({ available: false }))
    .then((r) => setAvailable(r.available)).catch(() => setAvailable(false));
  useEffect(() => {
    let alive = true;
    setAvailable(false);
    if (target) {
      api.aiStatus(user!, target)
        .then((r) => { if (alive) setAvailable(r.available); })
        .catch(() => { if (alive) setAvailable(false); });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 宛先は targetKey で見る
  }, [user, targetKey]);

  if (!available) return null;
  // 日誌は「文があるか」（見出しの行だけの本文は文が無いとみなす）で、入れるか候補で示すかを決める
  const hasText = diary ? diary.hasSentence : text.trim() !== '';
  const roomForMore = max - [...text.trim()].length >= CONTINUE_MIN_ROOM;
  const checkNote = diary && !diary.share ? AI_TEXT.checkBeforeSave : AI_TEXT.checkBeforeSend;

  /*
   * 作っている間はパネルのボタンがすべて押せなくなり、押したボタンからフォーカスが外れて body に落ちる。
   * 応答のあとに決めた場所へ移す（src/focusAfter.ts、WCAG 2.4.3、GitHub Issue #213）：
   *   - 言い換え・続き：押したボタンが残るので、押せるようになったらそこへ戻す（成功・失敗とも）
   *   - メモの「下書きを作る」：作れたらメモの欄が閉じてボタンが消えるので、欄を開いた「AI で下書き」へ移す
   *     （窓の中で押して窓が閉じたら開いた元へ戻すのと同じ）。作れなかったら欄が残るので、押した「下書きを作る」へ戻す
   */
  const make = async (purpose: AiPurpose) => {
    if (making) return;
    const pressed = focusedNow();
    let closed = false;
    setMaking(purpose); setError(null); setResult(null);
    try {
      const res = await api.aiDrafts(user!, diary
        ? {
            purpose: 'diary', record_type: diary.recordType, class_id: diary.classId, date, memo: memo.trim(),
            headings: diary.headings, share_to_guardian: diary.share,
            ...(diary.recordType === '1' ? { child_id: childId } : {}),
          }
        : {
            purpose: purpose as Exclude<AiPurpose, 'diary'>, child_id: childId!, date, field,
            ...(purpose === 'facility_note' ? { memo: memo.trim() } : { text: text.trim() }),
          });
      // 欄が空なら下書きをそのまま入れる。文があれば置き換えずに候補として出す
      const insertNow = (purpose === 'facility_note' || purpose === 'diary') && !hasText && res.drafts.length === 1;
      if (insertNow) onUse(res.drafts[0], 'replace');
      setResult({ purpose, drafts: res.drafts, replaced: res.replaced_other_names, inserted: insertNow });
      if (purpose === 'facility_note' || purpose === 'diary') { setMemoOpen(false); closed = true; }
    } catch (e) {
      setError((e as Error).message);
      // キーが無効と分かったときなどは、読み直すとボタンが消える
      void readStatus();
    } finally {
      setMaking(null);
      focusAfter(pressed, closed ? () => draftButton.current : undefined);
    }
  };

  /*
   * 押すと押したボタンごと消えるもの（GitHub Issue #213）：
   *   - 「この文を使う」・結果の「閉じる」：候補・結果の欄が消えるので、入力欄へ移す
   *   - メモの欄の「閉じる」：欄が消えるので、欄を開いた「AI で下書き」へ戻す（「下書きを作る」で作れたときと同じ）
   */
  const closeMemo = () => {
    const pressed = focusedNow();
    setMemoOpen(false);
    focusAfter(pressed, () => draftButton.current);
  };
  const closeResult = () => {
    const pressed = focusedNow();
    setResult(null);
    if (focusAfterUse) focusAfter(pressed, focusAfterUse);
  };
  const use = (d: string) => {
    const pressed = focusedNow();
    onUse(d, result?.purpose === 'continue' ? 'append' : 'replace');
    setResult((r) => (r ? { ...r, drafts: [], inserted: true } : r));
    if (focusAfterUse) focusAfter(pressed, focusAfterUse);
  };

  return (
    <div className="ai-draft">
      <div className="ai-draft-buttons" role="group" aria-label="AI の下書き">
        {allowDraft && (
          <button ref={draftButton} type="button" className="contact-pick" aria-expanded={memoOpen} disabled={disabled || making !== null}
            onClick={() => { setMemoOpen((o) => !o); setError(null); }}>{AI_TEXT.draftButton}</button>
        )}
        {!diary && (
          <>
            <button type="button" className="contact-pick" disabled={disabled || making !== null || !hasText}
              onClick={() => void make('rephrase')}>{AI_TEXT.rephraseButton}</button>
            <button type="button" className="contact-pick" disabled={disabled || making !== null || !hasText || !roomForMore}
              onClick={() => void make('continue')}>{AI_TEXT.continueButton}</button>
          </>
        )}
      </div>

      {memoOpen && (
        <div className="ai-draft-memo">
          {/* 【仮置き】メモの欄の見出し（web/仮置き値.md） */}
          <label htmlFor={memoId}>メモ（なくてもよい。箇条書き・話し言葉でよい）</label>
          <p className="muted" id={`${memoId}-note`}>{AI_TEXT.memoNote}</p>
          <textarea id={memoId} aria-describedby={`${memoId}-note`} value={memo} maxLength={MEMO_MAX}
            onChange={(e) => setMemo(e.target.value)} />
          <div className="contact-composer-actions">
            <button type="button" className="btn-primary" onClick={() => void make(diary ? 'diary' : 'facility_note')} disabled={making !== null}
              aria-busy={making === 'facility_note' || making === 'diary'}>{AI_TEXT.makeDraft}</button>
            <button type="button" onClick={closeMemo} disabled={making !== null}><CloseIcon />閉じる</button>
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
          <p className="ai-draft-note">{checkNote}</p>
          {result.replaced && <p className="ai-draft-note">{AI_TEXT.replacedOthers}</p>}
          <button type="button" className="btn-quiet" onClick={closeResult}>閉じる</button>
        </div>
      )}
    </div>
  );
}
