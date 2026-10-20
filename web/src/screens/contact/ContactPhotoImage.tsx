/*
 * 連絡帳の写真を1枚出す（押すと画面いっぱいに出す）
 * 典拠：詳細設計書「写真の実体」(4-4 (3))（画面は <img src="/api/contact/photos/{id}"> で読む。Cookie が送られる）・
 *      「保護者ホーム」(2-5 (2))（写真は 56px の小さな絵）・「連絡帳画面（保護者）」(2-6 (5))（写真は時刻と絵。押すと PhotoViewer）
 *
 * URL は api.photoUrl で得る（http は経路の文字列、モックは URL.createObjectURL の URL）。見てよいかの判定はサーバ
 * （モックは photoUrl）が行う。取り消した・見られない写真は「この写真は開けません。」を出す。
 */
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useSession } from '../../session';
import { MSG } from '../../messages';
import PhotoViewer from './PhotoViewer';
import '../../styles/contactPhoto.css';

export default function ContactPhotoImage({ photoId, label, size }: {
  photoId: number;
  /** 何の写真か（「10:15 の写真」など）。絵の代わりの文と、窓の題に使う */
  label: string;
  /** timeline：連絡帳のページ（160×120）、thumb：保護者ホーム（56px）、cell：連絡帳（クラス）画面の表（44px） */
  size: 'timeline' | 'thumb' | 'cell';
}) {
  const { user } = useSession();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    api.photoUrl(user, photoId).then((url) => { if (alive) { setSrc(url); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [user, photoId]);

  if (failed) return <span className="muted contact-photo-missing">{MSG.photoForbidden}</span>;
  if (!src) return <span className={`contact-photo-placeholder is-${size}`} aria-hidden="true" />;
  return (
    <>
      <button type="button" className="contact-photo-button" onClick={() => setOpen(true)} aria-label={`${label}を大きく見る`}>
        <img className={`contact-photo is-${size}`} src={src} alt="" onError={() => setFailed(true)} />
      </button>
      {open && <PhotoViewer src={src} alt={label} onClose={() => setOpen(false)} />}
    </>
  );
}
