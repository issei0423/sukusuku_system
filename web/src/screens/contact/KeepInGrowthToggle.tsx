/*
 * 「成長の記録に残す」の付け外し（職員の画面のひとこと・写真の行に置く）
 * 典拠：詳細設計書「職員の画面から成長の記録へ届けるもの」(2-12 (1))・「成長の記録」(4-12 (3))、
 *      図/画面詳細図「連絡帳（園児）画面」(8-2) の項目8
 *
 * 押すと POST /api/contact/events/{id}/keep-in-growth。楽観的更新をしない（サーバが返した状態だけを出す。詳細設計書 (2-0 (2))）。
 * 直せる人（その日はクラスの担任、翌日以降は管理者）でなければ、押せない形で「成長の記録に残しています」とだけ出す。
 * 付け外しは連絡帳の中身を変えないため、保護者の連絡帳に「訂正しました」は出ない。
 */
import { useState } from 'react';
import { api } from '../../api/client';
import type { ContactEvent } from '../../api/shapes';
import { useSession } from '../../session';
import { notify } from '../../components/feedback';
import { TEXT } from '../../messages';

export default function KeepInGrowthToggle({ event, canFix, onChanged }: {
  event: ContactEvent;
  /** 直せる人か（詳細設計書「訂正・取り消しのまとめ」(3-5) の canCorrect） */
  canFix: boolean;
  /** 押したあと（うまくいっても失敗しても）ページを読み直す */
  onChanged: () => void;
}) {
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  if (event.event_type !== '4' && event.event_type !== '5') return null;
  if (!canFix || !event.updated_at) {
    return event.keep_in_growth ? <span className="muted contact-keep-growth">{TEXT.keptInGrowthReadOnly}</span> : null;
  }
  const toggle = async () => {
    setBusy(true);
    try {
      const saved = await api.keepInGrowth(user!, event.contact_event_id, !event.keep_in_growth, event.updated_at!);
      notify(saved.keep_in_growth ? TEXT.keptInGrowth : TEXT.removedFromGrowth);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <label className="contact-keep-growth">
      <input type="checkbox" checked={event.keep_in_growth} disabled={busy} onChange={() => void toggle()} />
      <span>{TEXT.keepInGrowth}</span>
    </label>
  );
}
