/*
 * 共有された日誌の閲覧（保護者）
 *
 * 【この画面は「画面の一覧」(3-2) の33画面に含まれていない。】
 * 図/画面詳細図.md「チャット画面（保護者・スマートフォン）」(4-2) の【要確認】に
 * 「共有された日誌を開いた先の画面が定義されていない」と挙げられている
 * （図/画面遷移図.md「要確認事項」(8) No.3）。
 *
 * チャットの中に日誌の本文をそのまま流すと、長文が会話を押し流し、
 * あとから探せなくなる。そのため本モックでは開いた先の画面として実装した。
 * 画面として起こすか、チャット内の展開で足りるかは設計側で決める必要がある。
 */
import { Link, useParams } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { useSession } from '../../session';
import { api, childName, staffName } from '../../api/client';
import { Loading, ErrorBox, Empty } from '../../components/ui';
import { DIARY_RECORD_TYPE } from '../../api/codes';
import { formatYMD } from '../../api/util';

export default function GuardianDiaryScreen() {
  const { user } = useSession();
  const { id } = useParams();
  const diary = useAsync(() => api.getDiary(user!, Number(id)), [id]);
  const attachments = useAsync(() => api.attachmentsOf(Number(id)), [id]);

  if (diary.loading) return <Loading />;
  if (diary.error) return <ErrorBox text={diary.error} />;
  const d = diary.data;
  if (!d) return null;

  // 承認済みかつ共有指定のあるものだけを見せる。承認と共有は別の指定（基本設計書 5-4）
  if (d.status !== '3' || !d.is_shared_to_guardian) {
    return <Empty text="この記録は共有されていません。" />;
  }

  return (
    <div>
      <div className="page-head">
        <Link className="btn btn-quiet btn-sm" to="/guardian">&lt; ホームへ</Link>
      </div>

      <section className="card">
        <h2>{formatYMD(d.diary_date)}</h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          {DIARY_RECORD_TYPE[d.record_type]}
          {d.child_id && <>／{childName(d.child_id)}</>}
        </div>
        <div style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>

        {(attachments.data?.length ?? 0) > 0 && (
          <div className="row" style={{ marginTop: 16 }}>
            {attachments.data!.map((a, i) => (
              <span key={a.diary_attachment_id} className="tag tag-plain" style={{ padding: '24px 32px' }}>
                写真 {i + 1}
              </span>
            ))}
          </div>
        )}

        <div className="muted" style={{ marginTop: 16 }}>
          記入：{staffName(d.created_staff_id)}
          {d.approved_at && <>　／　確認：{staffName(d.approved_staff_id)}</>}
        </div>
      </section>

      <section className="card card-sub">
        <div className="muted">
          この記録についてのご質問は、チャットからお送りください。
          お急ぎの場合はお電話でお願いします。
        </div>
        <Link className="btn btn-block" to="/guardian/chat" style={{ marginTop: 8 }}>チャットを開く</Link>
      </section>
    </div>
  );
}
