/*
 * 配布物を開いたときの表示
 * 典拠：図/画面詳細図.md「配布物一覧画面（保護者）」・「配布物管理画面」
 *
 * 【モックアップの範囲】ファイルの実体は保存していないため、中身は表示できない。
 * 題名・種類・対象の月・ファイルの名前と大きさを示すに留める（web/仮置き値.md）。
 * 本実装では、権限の判定を通してからファイルを配信する（基本設計書「添付ファイルの実体の保存先」(5-5)）。
 */
import { Modal, Tag } from './ui';
import { HANDOUT_TYPE } from '../api/codes';
import { formatFileSize, formatMonth, formatMDHM } from '../api/util';
import type { Handout } from '../api/types';
import { CloseIcon } from './icons';

export default function HandoutViewer({ handout, onClose }: { handout: Handout; onClose: () => void }) {
  return (
    <Modal title={handout.title} onClose={onClose}
      footer={<button className="btn-primary" onClick={onClose}><CloseIcon />閉じる</button>}>
      <div className="stack">
        <div>
          <Tag label={HANDOUT_TYPE[handout.handout_type] ?? 'その他'} className="tag-applied" />
          {' '}{formatMonth(handout.target_month)}　／　{handout.class_name ?? '園全体'}
        </div>
        <div className="handout-preview">
          <div className="name">{handout.file_name}</div>
          <div className="muted">
            {handout.file_type === 'application/pdf' ? 'PDF' : '画像'}・{formatFileSize(handout.file_size)}
          </div>
          <div className="muted" style={{ marginTop: 12 }}>
            モックアップではファイルの実体を保存していないため、中身は表示されません。
          </div>
        </div>
        <div className="muted">掲載：{formatMDHM(handout.posted_at)}</div>
      </div>
    </Modal>
  );
}
