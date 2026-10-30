/*
 * 取り込んだ記録の訂正の表示（日誌作成・編集画面と日誌承認画面の本文の上）
 * 典拠：図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目25・「日誌承認画面（管理者）」(3-5) 項目9、
 *      基本設計書.md「入力項目の制約値とメッセージ一覧」(4-12)「取り込んだ記録の訂正」、
 *      詳細設計書.md「日誌の画面（作り直し）」(2-13 (5))
 *
 * 個人日誌に取り込んだきょうのようすが、取り込んだあとで連絡帳で訂正・取り消しされていれば、その旨とどの記録かを示す。
 * 本文は自動では書き換えない。GitHub Issue #278 の 2
 */
import { Alert } from '../../components/ui';
import { MEAL_KIND_TEXT } from '../../messages';
import { formatHM } from '../../api/util';
import type { DiaryContactChange } from '../../api/types';

export function ContactChangesBand({ changes }: { changes: DiaryContactChange[] | undefined }) {
  if (!changes || changes.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <Alert>
        取り込んだあとに連絡帳で訂正・取り消しされた記録があります。本文を確かめてください。
        <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
          {changes.map((c, i) => (
            <li key={`${c.kind}-${c.recorded_at}-${i}`}>
              {formatHM(c.recorded_at)} {c.kind === 'nap' ? '午睡' : MEAL_KIND_TEXT[c.meal_kind ?? '1']}
              （{formatHM(c.changed_at)} に{c.change === 'correct' ? '訂正' : '取り消し'}）
            </li>
          ))}
        </ul>
      </Alert>
    </div>
  );
}
