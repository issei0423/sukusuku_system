/*
 * 宛先を大きく示す（段2を送る画面の「送る」のすぐ上。職員の画面だけ）
 * 典拠：詳細設計書「共通の部品」(2-0 (1)) の RecipientBadge、図/画面詳細図「宛先の表示」(1-3 (1))、
 *      基本設計書「送る時点の守り」(4-2) の 1
 *
 * 園児1人あて：園児名とクラスを大きく、顔写真（無ければ名前の1文字目の丸）、届く保護者の続柄（「父・祖母に届きます」）。
 * 保護者がまだ登録していない園児は「まだ保護者が登録していません（登録すると読めます）」。
 * この表示が確認を兼ねる（別の確認のダイアログは挟まない）。
 */
import type { ContactRecipient } from '../api/shapes';
import { TEXT } from '../messages';
import ChildAvatar from './ChildAvatar';

export default function RecipientBadge({ recipient, className }: { recipient: ContactRecipient; className?: string | null }) {
  const unregistered = recipient.relationships.length === 0;
  return (
    <div className={`recipient-badge${unregistered ? ' is-unregistered' : ''}`} role="note" aria-label="宛先">
      <span className="recipient-label">宛先</span>
      <ChildAvatar name={recipient.child_name} />
      <strong className="recipient-name">{recipient.child_name}{className ? `（${className}）` : ''}</strong>
      <span className="recipient-to">
        {unregistered ? TEXT.recipientUnregistered : `${[...new Set(recipient.relationships)].join('・')}に届きます`}
      </span>
    </div>
  );
}
