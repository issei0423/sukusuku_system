/*
 * 連絡帳（クラス）画面の「この日の写真」（クラスの園児に送った写真を小さく並べる）
 * 典拠：詳細設計書「連絡帳（クラス）画面」(2-2)・「写真を送る」(2-2 (7))（送ったあとは写っている子の行の「ひとこと・写真」の件数が増える）
 *
 * 表の「ひとこと・写真」の列は件数だけを出す（2-2 (6)）。写真そのものは表の上にまとめて出し、押すと画面いっぱいに出す。
 * 2人以上が写った写真は、写っている子の行ごとに出来事があるので、1枚にまとめて名前を並べる。
 * 【仮置き】表の上にまとめて出すこと・見出し「この日の写真」（web/仮置き値.md）
 */
import type { ContactClassRow } from '../../api/shapes';
import { formatHM } from '../../api/util';
import ContactPhotoImage from './ContactPhotoImage';
import '../../styles/contactPhoto.css';

export default function ClassPhotoStrip({ rows }: { rows: ContactClassRow[] }) {
  const photos = new Map<number, { at: string; names: string[] }>();
  for (const row of rows) {
    for (const e of row.events) {
      if (e.event_type !== '5' || e.contact_photo_id === null) continue;
      const p = photos.get(e.contact_photo_id) ?? { at: e.recorded_at, names: [] };
      if (!p.names.includes(row.child.child_name)) p.names.push(row.child.child_name);
      photos.set(e.contact_photo_id, p);
    }
  }
  if (photos.size === 0) return null;
  const list = [...photos.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at));
  return (
    <section className="class-photo-strip" aria-label="この日の写真">
      <h2>この日の写真</h2>
      <ul>
        {list.map(([id, p]) => (
          <li key={id}>
            <ContactPhotoImage photoId={id} label={`${p.names.join('・')}の写真（${formatHM(p.at)}）`} size="cell" />
          </li>
        ))}
      </ul>
    </section>
  );
}
