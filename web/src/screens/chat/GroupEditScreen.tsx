/*
 * グループ編成画面
 * 典拠：基本設計書.md「画面の一覧」(3-2)「目的別グループの作成とメンバーの編成」
 *
 * 退出は left_at を入れて所属期間を残す。過去ログの参照範囲の判定に用いるため（基本設計書 5-5）。
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Alert, Modal } from '../../components/ui';
import { ROLE } from '../../api/codes';

export default function GroupEditScreen() {
  const { user } = useSession();
  const [tick, setTick] = useState(0);
  /*
   * 一般の職員には、いま参加しているグループだけが返る。編成できるのはそれだけで、参加していないグループの
   * メンバーは返らないため（server/api_chat.go の handleChatGroups。GitHub Issue #172）。管理者にはすべて返る
   */
  const groups = useAsync(() => api.groups(user!), [tick, user?.account_id]);
  // 候補は職員だけ。一般の職員も編成できるため、管理者向けのアカウント一覧は使わない
  const accounts = useAsync(() => api.groupCandidates(user!), [user?.account_id]);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * 作る・保存するの間は押せなくし、続けて押しても2つ作らない（GitHub Issue #303。詳細設計書「押したときの処理の型」(2-0 (2))）。
   * 押せなくなるのは描き直しのあとなので、その前に届いた2回目は saving で止める
   */
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);

  const members = useAsync(async () => (editing ? api.members(editing, user!) : []), [editing]);

  const create = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.createGroup(user!, name, picked);
      setCreating(false); setName(''); setPicked([]);
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); } finally { saving.current = false; setBusy(false); }
  };

  const saveMembers = async () => {
    if (!editing || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.updateGroupMembers(user!, editing, picked);
      setEditing(null); setPicked([]);
      setTick((n) => n + 1);
    } catch (e) { setError((e as Error).message); } finally { saving.current = false; setBusy(false); }
  };

  // メンバーを読めなかったとき（別の画面で外されたなど）は、編成を開かずに知らせる（GitHub Issue #172）
  const openEdit = async (roomId: number) => {
    setError(null);
    try {
      const m = await api.members(roomId, user!);
      setPicked(m.map((x) => x.account_id));
      setEditing(roomId);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/staff/chat">&lt; チャットへ</Link>
        <h1>グループ編成</h1>
        <div className="spacer" />
        <button className="btn-primary" onClick={() => { setPicked([]); setName(''); setCreating(true); }}>
          ＋ グループを作る
        </button>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div>}
      {accounts.error && <div style={{ marginBottom: 16 }}><ErrorBox text={accounts.error} /></div>}

      <section className="card">
        {groups.loading && <Loading />}
        {groups.error && <ErrorBox text={groups.error} />}
        {groups.data?.length === 0 && <Empty text="目的別グループはまだありません。" />}
        {groups.data && groups.data.length > 0 && (
          <table className="list">
            <thead><tr><th scope="col">グループ名</th><th scope="col">メンバー</th><th scope="col">操作</th></tr></thead>
            <tbody>
              {groups.data.map((g) => (
                <tr key={g.chat_room_id}>
                  <td>{g.room_name}</td>
                  <td><MemberNames roomId={g.chat_room_id} tick={tick} /></td>
                  <td className="nowrap">
                    <button className="btn-sm" onClick={() => openEdit(g.chat_room_id)}>メンバーを編成</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card card-sub">
        <div className="muted">
          {/* クラスのグループはクラスと年度から自動で構成する（基本設計書「チャット」(5-5)） */}
          クラスのグループはクラスと年度から自動で構成されるため、ここには表示されません。
          <br />
          メンバーを外しても、その人が在籍していた期間のやりとりは記録として残ります。
        </div>
      </section>

      {creating && (
        <Modal title="グループを作る" onClose={() => setCreating(false)}
          footer={<>
            <button onClick={() => setCreating(false)}>やめる</button>
            <button className="btn-primary" onClick={create} disabled={busy || !name.trim()} aria-busy={busy}>作る</button>
          </>}>
          <div className="stack">
            <Field label="グループ名" required>
              <input type="text" value={name} maxLength={50} onChange={(e) => setName(e.target.value)} placeholder="運動会実行委員" />
            </Field>
            <Field label="メンバー">
              <AccountPicker accounts={accounts.data ?? []} picked={picked} onChange={setPicked} />
            </Field>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="メンバーの編成" onClose={() => setEditing(null)}
          footer={<>
            <button onClick={() => setEditing(null)}>やめる</button>
            <button className="btn-primary" onClick={saveMembers} disabled={busy} aria-busy={busy}>保存する</button>
          </>}>
          <div className="muted" style={{ marginBottom: 8 }}>
            現在：{members.data?.map((m) => m.name).join('、') || 'なし'}
          </div>
          <AccountPicker accounts={accounts.data ?? []} picked={picked} onChange={setPicked} />
        </Modal>
      )}
    </div>
  );
}

/*
 * 一覧のメンバー欄。編成を保存したら読み直す（tick）。チャンネルの番号だけを見ていると、保存しても
 * 再読み込みするまで古いメンバーのまま残る（GitHub Issue #172 の 5）。
 * 見る人（viewer）を渡し、参加していないグループのメンバーを返さない規則をモックでも通す（同 4）
 */
function MemberNames({ roomId, tick }: { roomId: number; tick: number }) {
  const { user } = useSession();
  const m = useAsync(() => api.members(roomId, user!), [roomId, tick, user?.account_id]);
  return <span className="muted">{m.data?.map((x) => x.name).join('、') ?? ''}</span>;
}

function AccountPicker({ accounts, picked, onChange }: {
  accounts: { account_id: number; name: string; role: string }[];
  picked: number[];
  onChange: (ids: number[]) => void;
}) {
  const toggle = (id: number) =>
    onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  return (
    <div className="stack" style={{ maxHeight: 260, overflowY: 'auto' }}>
      {accounts.map((a) => (
        <label key={a.account_id}>
          <input type="checkbox" checked={picked.includes(a.account_id)} onChange={() => toggle(a.account_id)} />
          {a.name}
          <span className="muted">（{ROLE[a.role as '1' | '2' | '3']}）</span>
        </label>
      ))}
    </div>
  );
}
