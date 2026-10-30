/*
 * きょうは対象外の理由を選ぶ（欠席・午睡なし）
 * 典拠：詳細設計書「午睡チェック画面（ねた・おきた・きょうは対象外）」(2-4 (1))・「行の状態ごとの表示」(2-4 (2))
 *
 * 行の「対象外」→ 理由を押す、の2タップ。理由を押すとそのまま送る（確認のダイアログは出さない。段1の記録のため）。
 * 対象外は監査の層で、保護者へは出さない。
 * フォーカス：開くと「やめる」に入る（窓の部品 Modal の data-initial-focus）。理由を押すとすぐ記録され、その子はタイマーと未記録の数から外れるので、
 * 開いてすぐの Enter の押しすぎで寝ている子を確認の対象から外さないよう、いちばん弱い操作へ入れる
 * （取り返しにくい操作の窓の型。WAI-ARIA Authoring Practices「Dialog (Modal) Pattern」。2026-10-19 に決めた。PR #226）。
 * 理由を押したあとの移し先は SleepControls.tsx が決める（対象外にした → 同じ行の「戻す」、送れなかった → 押した理由。WCAG 2.4.3、GitHub Issue #213）
 */
import { Modal } from '../../components/ui';
import { CloseIcon } from '../../components/icons';

export default function ExclusionDialog({ name, busy, onSelect, onClose }: {
  name: string; busy: boolean; onSelect: (reason: '1' | '2') => void; onClose: () => void;
}) {
  return (
    <Modal title={`${name}をきょうは対象外にする`} onClose={onClose}
      footer={<button type="button" onClick={onClose} disabled={busy} data-initial-focus><CloseIcon />やめる</button>}>
      <p>理由を選ぶと記録します。対象外にした子は、タイマーと未記録の数から外れます。</p>
      <div className="nap-exclusion-choices">
        <button type="button" className="btn-primary" onClick={() => onSelect('1')} disabled={busy}>欠席</button>
        <button type="button" className="btn-primary" onClick={() => onSelect('2')} disabled={busy}>午睡なし</button>
      </div>
    </Modal>
  );
}
