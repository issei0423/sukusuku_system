/*
 * 画面の上端の帯。つながっていないことを隠さない
 * 典拠：詳細設計書「つながっているかの表示」(2-8)・「共通の部品」(2-0 (1))、基本設計書「つながっているかの表示」(3-5)
 *
 * | 状態 | 職員 | 保護者 |
 * | つながっている | 出さない | 出さない |
 * | 知らせが切れている | 出さない（ヘッダの LiveIndicator で足りる） | 細い帯「自動で読み直しています」 |
 * | サーバに届かない | 警告色の帯「サーバにつながりません。記録は保存されていません」 | 同じ |
 *
 * 午睡チェック画面では、サーバに届かない帯を大きく出す（高さ 64px・文字 20px。large）。
 * 接続を使っていないとき（ログイン前・モック）は何も出さない。
 */
import { useConnectionState, useLiveStatus } from '../live';
import { TEXT } from '../messages';

export default function ConnectionBanner({ audience, large = false }: { audience: 'staff' | 'guardian'; large?: boolean }) {
  const status = useLiveStatus();
  const state = useConnectionState();
  if (status === 'off' || state === 'connected') return null;
  if (state === 'unreachable') {
    return (
      <div className={`connection-banner is-unreachable${large ? ' is-large' : ''}`} role="alert">
        {TEXT.unreachableBanner}
      </div>
    );
  }
  if (audience === 'staff') return null;
  return <div className="connection-banner is-fallback" role="status">{TEXT.liveFallback}</div>;
}
