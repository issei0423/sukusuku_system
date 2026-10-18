/*
 * きょうは対象外の理由を選ぶ（欠席・午睡なし）
 * 典拠：詳細設計書「午睡チェック画面（ねた・おきた・きょうは対象外）」(2-4 (1))・「行の状態ごとの表示」(2-4 (2))
 *
 * 行の「対象外」→ 理由を押す、の2タップ。理由を押すとそのまま送る（確認のダイアログは出さない。段1の記録のため）。
 * 対象外は監査の層で、保護者へは出さない。
 * フォーカス：開くと最初の理由「欠席」に入る（窓の部品 Modal の決まり）。理由を押したあとの移し先は SleepControls.tsx が決める
 * （対象外にした → 同じ行の「戻す」、送れなかった → 押した理由。WCAG 2.4.3、GitHub Issue #213）
 */
import { Modal } from '../../components/ui';

export default function ExclusionDialog({ name, busy, onSelect, onClose }: {
  name: string; busy: boolean; onSelect: (reason: '1' | '2') => void; onClose: () => void;
}) {
  return (
    <Modal title={`${name}をきょうは対象外にする`} onClose={onClose}
      footer={<button type="button" onClick={onClose} disabled={busy}>やめる</button>}>
      <p>理由を選ぶと記録します。対象外にした子は、タイマーと未記録の数から外れます。</p>
      <div className="nap-exclusion-choices">
        <button type="button" className="btn-primary" onClick={() => onSelect('1')} disabled={busy}>欠席</button>
        <button type="button" className="btn-primary" onClick={() => onSelect('2')} disabled={busy}>午睡なし</button>
      </div>
    </Modal>
  );
}
