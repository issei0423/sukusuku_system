/*
 * 写真を画面いっぱいに出す
 * 典拠：詳細設計書「連絡帳画面（保護者）」(2-6 (1)) の PhotoViewer・(2-6 (5))（写真は時刻と絵。押すと PhotoViewer）
 *
 * 窓（ui.tsx の Modal）で出す。閉じると、開いた元（押した写真）へフォーカスが戻る（GitHub Issue #213 の決まり）。
 */
import { Modal } from '../../components/ui';
import '../../styles/contactPhoto.css';

export default function PhotoViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div className="photo-viewer">
      <Modal title={alt} onClose={onClose}>
        <img className="photo-viewer-image" src={src} alt={alt} />
      </Modal>
    </div>
  );
}
