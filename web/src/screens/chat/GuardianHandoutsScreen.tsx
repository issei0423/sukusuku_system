/*
 * 配布物一覧画面（保護者・スマートフォン）
 * 典拠：図/画面詳細図.md「配布物一覧画面（保護者）」
 *
 * 園だより・献立表など、あとから見返すものを月ごとにまとめて並べる。
 * チャットは流れを追うものであり、毎月読み返すものを探す場所には向かない。
 * 掲載の知らせはチャットに届き、現物はここから開く。
 * 見られるのは、園全体向けと、自児がいま在籍するクラス向けのものだけである。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Field, Tag } from '../../components/ui';
import HandoutViewer from '../../components/HandoutViewer';
import { HANDOUT_TYPE } from '../../api/codes';
import { formatMonth } from '../../api/util';
import type { Handout } from '../../api/types';
import { BackIcon, ForwardIcon } from '../../components/icons';

export default function GuardianHandoutsScreen() {
  const { user } = useSession();
  const [type, setType] = useState('');
  // 園が掲載・取り下げしたら、開いたままでも読み直す（live.ts）
  const { data, error, loading } = useAsync(() => api.handouts(user!, { type }), [user?.account_id, type],
    { live: onLive('handout') });
  const [opened, setOpened] = useState<Handout | null>(null);

  // 月ごとにまとめる。並びは新しい月が上
  const months = Array.from(new Set((data ?? []).map((h) => h.target_month)));

  return (
    <div className="guardian-home chat-handouts">
      <Link className="btn btn-quiet btn-sm chat-back" to="/guardian/chat"><BackIcon />チャット・お知らせへ</Link>
      <h1 className="chat-title">園からの配布物</h1>
      {/* 園だより・献立表などを、月ごとに見返せる */}
      <div className="chat-filter">
        <Field label="種類">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">すべて</option>
            {Object.entries(HANDOUT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
      </div>

      {loading && <Loading />}
      {error && <ErrorBox text={error} />}
      {data?.length === 0 && <Empty text="配布物はまだありません。" />}

      {months.map((month) => (
        <section className="chat-month" key={month}>
          <h2>{formatMonth(month)}</h2>
          <div className="guardian-record-list">
            {data!.filter((h) => h.target_month === month).map((h) => (
              <button key={h.handout_id} className="guardian-record-link handout-row"
                onClick={() => setOpened(h)}>
                <span className="handout-title">
                  <Tag label={HANDOUT_TYPE[h.handout_type] ?? 'その他'} />
                  <span>{h.title}</span>
                </span>
                <ForwardIcon />
              </button>
            ))}
          </div>
        </section>
      ))}

      {opened && <HandoutViewer handout={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}
