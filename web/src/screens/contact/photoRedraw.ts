/*
 * 写真を送る前に、画面で向きを直して縮める
 * 典拠：詳細設計書「写真を送る」(2-2 (7)) の①、決めたこと D-6
 *
 * 撮った写真は、付帯情報（EXIF）の向きに従って描き直し、長い辺 1600px・JPEG（品質 0.85）にする。
 * 描き直すと、位置情報などの付帯情報はここで落ちる。サーバも読み直して描き直す（server/api_contact_photo.go）。
 * サーバは描き直すときに向きの情報を使わずに捨てるので、向きは画面で直しておく。
 */
import { MSG } from '../../messages';

/** 長い辺の上限と JPEG の品質（詳細設計書 (2-2 (7)) の①） */
export const PHOTO_LONG_EDGE = 1600;
export const PHOTO_JPEG_QUALITY = 0.85;

/** 長い辺が max を超えるときだけ、縦横の比を保って縮める */
export function fitSize(width: number, height: number, max = PHOTO_LONG_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const r = max / long;
  return { width: Math.max(1, Math.round(width * r)), height: Math.max(1, Math.round(height * r)) };
}

/**
 * 選んだ写真を確かめる。JPEG・PNG で、attachment.max_size_mb まで。だめなら文言を返す。
 * ここで見るのは端末が付けた形式だけ。中身の形式はサーバが先頭のバイトで確かめる（申告は使わない）
 */
export function photoProblem(file: Blob, maxMb: number): string | null {
  if (!['image/jpeg', 'image/png'].includes(file.type)) return MSG.photoFormat;
  if (file.size === 0 || file.size > maxMb * 1024 * 1024) return MSG.photoFormat;
  return null;
}

type Drawable = { source: CanvasImageSource; width: number; height: number; done: () => void };

/**
 * 写真を、向きを直して読む。createImageBitmap が使えれば imageOrientation: 'from-image' で読む。
 * 【仮置き】使えない端末では img で読む（img も付帯情報の向きに従って描く。推測：いまの主なブラウザの既定。web/仮置き値.md）
 */
async function load(file: Blob): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close?.() };
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(MSG.photoFormat));
    img.src = url;
  });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** 向きを直し、長い辺 1600px・JPEG（品質 0.85）に描き直す。読めない写真は「写真は JPEG・PNG で、10MB までです。」 */
export async function redrawPhoto(file: Blob): Promise<Blob> {
  let drawable: Drawable;
  try {
    drawable = await load(file);
  } catch {
    throw new Error(MSG.photoFormat);
  }
  try {
    const { width, height } = fitSize(drawable.width, drawable.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(MSG.photoFormat);
    ctx.drawImage(drawable.source, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(MSG.photoFormat))), 'image/jpeg', PHOTO_JPEG_QUALITY);
    });
  } finally {
    drawable.done();
  }
}
