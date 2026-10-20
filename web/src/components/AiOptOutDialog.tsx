/*
 * 保護者のメニューの「AI の下書きの利用」（ダイアログ）
 * 典拠：詳細設計書「AI の下書きの利用」(2-15 (4))・経路 (4-15 (3))・決めたこと D-49、
 *      図/画面詳細図「AI の下書きの利用（保護者のメニュー）」(1-3 (10))、基本設計書「園の有効化と保護者の拒否」(4-11)
 *
 * 紐づけが有効な自児ごとに「〇〇の文に AI の下書きを使わない」を並べ、押すたびに保存する（確認のダイアログは出さない。
 * 押し直せば戻り、外部へ送る側を止める操作であるため）。初期値は、ログイン中の保護者自身の紐づけの値（GuardianToday.ai_opt_out）。
 * ほかの家族が断っているかは出さない（家族どうしの設定を見せ合わない）。権限の担保はサーバ（server/api_guardian.go）
 */
import { useState } from 'react';
import { api } from '../api/client';
import type { GuardianHomeRow } from '../api/shapes';
import type { SessionUser } from '../api/types';
import { AI_OPT_OUT_TEXT } from '../messages';
import { notify } from './feedback';
import { Modal } from './ui';

export default function AiOptOutDialog({ user, rows, onChanged, onClose }: {
  user: SessionUser;
  /** 保護者ホームの区画（GET /api/dashboard/guardian）。メニューのために別の経路を読まない（2-15 (1)） */
  rows: GuardianHomeRow[];
  /** 保存したあと、区画を読み直させる */
  onChanged: () => void;
  onClose: () => void;
}) {
  // 紐づけが有効な自児だけ（猶予中の子は区画に出るが、切り替えられない。4-15 (3)）。並びは区画のまま（年上の子から）
  const children = rows.map((r) => r.today).filter((t) => t.grace_ends_on === null);
  const [values, setValues] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(children.map((t) => [t.child_id, t.ai_opt_out])));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (childId: string, childName: string, optOut: boolean) => {
    if (busy) return;
    setBusy(childId);
    setError(null);
    api.aiOptOut(user, childId, optOut)
      .then(() => {
        setValues((v) => ({ ...v, [childId]: optOut }));
        notify(optOut ? AI_OPT_OUT_TEXT.optedOut(childName) : AI_OPT_OUT_TEXT.optedIn);
        onChanged();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  return (
    <Modal title={AI_OPT_OUT_TEXT.title} onClose={onClose}>
      <p>{AI_OPT_OUT_TEXT.explain}</p>
      {children.length === 0 && <p className="muted">{AI_OPT_OUT_TEXT.noChildren}</p>}
      {/* きょうだいは園児ごとに1行（label は横に並ぶため、縦に積む） */}
      <div className="stack">
        {children.map((t) => (
          <label key={t.child_id}>
            <input type="checkbox" checked={!!values[t.child_id]} disabled={busy !== null}
              aria-busy={busy === t.child_id}
              onChange={(e) => toggle(t.child_id, t.child_name, e.target.checked)} />
            {AI_OPT_OUT_TEXT.label(t.child_name)}
          </label>
        ))}
      </div>
      {error && <p className="contact-error" role="alert">{error}</p>}
    </Modal>
  );
}
