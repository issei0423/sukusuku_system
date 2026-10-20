/*
 * 設定画面（管理者）
 * 典拠：詳細設計書「設定画面（管理者）」(2-14)・「設定」(4-10)、決めたこと D-15
 *
 * 経路は /staff/admin/settings（クエリ tab）。管理者だけ（一般がアドレスから開いたら職員ダッシュボードへ戻す。App.tsx の RequireAdmin）。
 * 本版（実装の順番の 10）は AI の区画だけを作る（ai.enabled の既定は「使わない」で、画面が無いと AI のデモができないため）。
 * 連絡帳・定型文と雛形・通知・クラス・そのほかの設定値の区画は、実装の順番の 14 で足す。
 *
 * 設定は GET /api/settings で読み、区画には読んだ値を渡す。保存したら応答（新しい値と read_at）に入れ替え、
 * ほかの管理者が先に変えていたら（409）読み直して、その旨を出す。
 */
import { useState } from 'react';
import { api } from '../../../api/client';
import type { SettingsView } from '../../../api/shapes';
import { useSession } from '../../../session';
import { useAsync } from '../../../hooks';
import { Alert, ErrorBox, Loading } from '../../../components/ui';
import { notify } from '../../../components/feedback';
import { AI_TEXT } from '../../../messages';
import AiSettings from './AiSettings';

export default function SettingsScreen() {
  const { user } = useSession();
  const loaded = useAsync(() => api.settings(user!), [user?.account_id]);
  const [latest, setLatest] = useState<SettingsView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const view = latest ?? loaded.data;

  /** ほかの管理者が先に変えていた：読み直して、その旨を出す */
  const reload = async (message: string) => {
    setNotice(message); setSaved(false);
    try {
      setLatest(await api.settings(user!));
    } catch (e) {
      setNotice(`${message}（${(e as Error).message}）`);
    }
  };

  return (
    <div className="settings-screen">
      <div className="page-head">
        <h1>設定</h1>
      </div>
      {notice && <Alert>{notice}</Alert>}
      {saved && <p className="settings-saved" role="status">{AI_TEXT.saved}</p>}
      {loaded.error && !latest ? <ErrorBox text={loaded.error} />
        : !view ? <Loading />
          : <AiSettings key={view.read_at} view={view} onSaved={(v) => { setNotice(null); setSaved(true); setLatest(v); notify(AI_TEXT.saved); }}
            onEdit={() => setSaved(false)} onConflict={(m) => void reload(m)} />}
    </div>
  );
}
