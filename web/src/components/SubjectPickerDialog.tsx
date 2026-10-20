/*
 * 写っている子を選ぶ（写真を送る画面の②）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の SubjectPickerDialog・「写真を送る」(2-2 (7)) の②・「写真」(3-3)、
 *      基本設計書「写真の同意で止める規則」(4-2)
 *
 * クラスの園児を、顔写真（無ければ名前の1文字目の丸）と名前の格子で並べ、複数選べる。顔の自動判定はしない。
 * 「子どもは写っていない」（作品・景色など）を選ぶと、届ける子を1人選ばせる。どちらも選ばなければ決められない。
 * 選んだ子の同意を画面でも先に確かめ、満たさない子の格子に「園内記録のみ」「ほかの家庭には出せない」を出す
 * （写真を送る画面の「送る」が押せなくなる。担保はサーバ）。【仮置き】窓の題・説明・ボタンの文言（web/仮置き値.md）
 */
import { useState } from 'react';
import { MSG } from '../messages';
import ChildAvatar from './ChildAvatar';
import { Modal } from './ui';
import { consentMark } from './photoConsent';
import type { PickerChild, SubjectSelection } from './photoConsent';
import '../styles/contactPhoto.css';

export default function SubjectPickerDialog({ candidates, initial, onDone, onClose }: {
  candidates: PickerChild[];
  initial: SubjectSelection;
  onDone: (selection: SubjectSelection) => void;
  onClose: () => void;
}) {
  const [subjects, setSubjects] = useState<string[]>(initial.subjects);
  const [noChildren, setNoChildren] = useState(initial.noChildren);
  const [target, setTarget] = useState<string | null>(initial.target);
  const toggle = (id: string) => {
    setNoChildren(false);
    setSubjects((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const chooseNone = () => {
    setSubjects([]);
    setNoChildren((v) => !v);
  };
  const ready = noChildren ? target !== null : subjects.length > 0;

  return (
    <Modal title="写っている子を選ぶ" onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose}>やめる</button>
        <button type="button" className="btn-primary" disabled={!ready}
          onClick={() => onDone({ subjects: noChildren ? [] : subjects, noChildren, target: noChildren ? target : null })}>決める</button>
      </>}>
      <div className="subject-picker">
        <p className="muted">写っている子を、全員選んでください。</p>
        <div className="subject-grid" role="group" aria-label="写っている子">
          {candidates.map((c) => {
            const selected = subjects.includes(c.child_id);
            const mark = selected ? consentMark(c.photo_consent_level, subjects.length) : null;
            return (
              <button key={c.child_id} type="button" className="subject-cell" aria-pressed={selected}
                aria-label={`${c.child_name}${mark ? `（${mark}）` : ''}`} onClick={() => toggle(c.child_id)}>
                <ChildAvatar name={c.child_name} />
                <span className="subject-cell-name">{c.child_name}</span>
                {mark && <span className="subject-consent">{mark}</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className="subject-picker-none" aria-pressed={noChildren} onClick={chooseNone}>子どもは写っていない</button>
        {noChildren && (
          <div className="subject-grid" role="group" aria-label="届ける子（1人）">
            {candidates.map((c) => (
              <button key={c.child_id} type="button" className="subject-cell" aria-pressed={target === c.child_id}
                aria-label={`${c.child_name}に届ける`} onClick={() => setTarget(c.child_id)}>
                <ChildAvatar name={c.child_name} />
                <span className="subject-cell-name">{c.child_name}</span>
              </button>
            ))}
          </div>
        )}
        {!ready && <p className="muted" role="status">{MSG.photoSubjectRequired}</p>}
      </div>
    </Modal>
  );
}
