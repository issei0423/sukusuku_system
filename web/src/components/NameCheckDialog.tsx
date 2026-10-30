/*
 * 他児の名前の注意（ダイアログ）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の NameCheckDialog・「他児の名前の照合」(4-5 (2))、
 *      図/画面詳細図「他児の名前の注意」(1-3 (3))、基本設計書「メッセージ一覧」(4-12)
 *
 * サーバが本文を照合して当たったときだけ開く（決めたこと D-4）。当たった語を強調して示し、「直す」か「このまま送る」を選ばせる。
 * 機械的な文字の照合であり、判断ではない。送るかどうかは送る人が決める。入力中の内容は消さない。
 */
import type { NameMatch } from '../api/shapes';
import { otherNamesMessage, TEXT } from '../messages';
import { Modal } from './ui';
import { EditIcon, SendIcon } from './icons';

/** 本文を、当たった位置で区切る（位置は符号位置で数える） */
function segments(text: string, matches: NameMatch[]): { text: string; hit: boolean }[] {
  const runes = [...text];
  const hit = new Array<boolean>(runes.length).fill(false);
  for (const m of matches) for (let i = Math.max(0, m.start); i < Math.min(runes.length, m.end); i++) hit[i] = true;
  const out: { text: string; hit: boolean }[] = [];
  runes.forEach((r, i) => {
    const last = out[out.length - 1];
    if (last && last.hit === hit[i]) last.text += r;
    else out.push({ text: r, hit: hit[i] });
  });
  return out;
}

export default function NameCheckDialog({ names, matches, text, busy, onFix, onSend }: {
  names: string[]; matches: NameMatch[]; text: string; busy: boolean;
  /** 直す：閉じて入力へ戻る（送らない） */
  onFix: () => void;
  /** このまま送る：承諾を付けて送り直す */
  onSend: () => void;
}) {
  // 【仮置き】窓の題（web/仮置き値.md）。注意の文は基本設計書「メッセージ一覧」(4-12) のもの
  return (
    <Modal title="ほかのお子さんの名前の注意" onClose={onFix}
      footer={<>
        <button type="button" onClick={onFix} disabled={busy}><EditIcon />直す</button>
        <button type="button" className="btn-primary" onClick={onSend} disabled={busy} aria-busy={busy}><SendIcon />{busy ? TEXT.sending : 'このまま送る'}</button>
      </>}>
      <p className="name-check-message" role="alert">{otherNamesMessage(names)}</p>
      <p className="name-check-text">
        {segments(text, matches).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
      </p>
    </Modal>
  );
}
