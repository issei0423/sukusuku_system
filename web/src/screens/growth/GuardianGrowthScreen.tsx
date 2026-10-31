/*
 * 成長の記録画面（保護者・スマートフォン）
 * 典拠：詳細設計書「成長の記録画面（保護者）」(2-11)・「成長の記録」(4-12 (1))、
 *      図/画面詳細図「成長の記録画面（保護者・スマートフォン）」(6-6)、基本設計書「成長の記録の閲覧（保護者）」(4-9)
 *
 * 上から：見出し（園児名。顔写真は出さない）→ 身長・体重（切り替えとグラフ・出典）→ 測った値 → できたこと →
 * さらに読み込む → 免責（画面の下端に止める）。
 * 何を出すかはサーバが開いた時点の設定で決める。画面は返ってきた事実を並べるだけで、評価の言葉を足さない。
 * 発達・身体測定・連絡帳の知らせ（この園児のもの）を受けたら1ページ目から読み直し、読み足した分は捨てる。
 * 画面の中で別の園児へ切り替える操作は置かない。開いた時刻は記録しない。
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { GrowthEntry, GrowthRecord } from '../../api/shapes';
import { useSession } from '../../session';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import type { LiveEvent } from '../../live';
import { Disclaimer, ErrorBox, Loading } from '../../components/ui';
import GrowthChart from '../../components/GrowthChart';
import { TEXT } from '../../messages';
import GrowthTimeline from './GrowthTimeline';
import { monthDay } from './growthText';
import MeasurementList from './MeasurementList';
import { BackIcon, SelectedIcon } from '../../components/icons';

/** この園児の発達チェック・身体測定・連絡帳の知らせだけを通す（詳細設計書 (2-11 (2))） */
const onGrowthChild = (childId: string) => (e: LiveEvent) =>
  (e.type === 'development' || e.type === 'physical' || e.type === 'contact') && e.child_id === childId;

export default function GuardianGrowthScreen() {
  const { childId = '' } = useParams();
  const { user } = useSession();
  const page = useAsync(() => api.growthRecord(user!, childId), [user?.account_id, childId],
    { refreshMs: AUTO_REFRESH_MS, live: onGrowthChild(childId) });
  const data = page.data;

  /*
   * 「さらに読み込む」で読み足した分と、その失敗。読み足したときの1ページ目（base）に結びつけておき、
   * 知らせで1ページ目を読み直したら（base が変わったら）捨てる（届いたものが先頭に入るため）
   */
  const [more, setMore] = useState<{ base: GrowthRecord; entries: GrowthEntry[]; next: string | null } | null>(null);
  const [moreError, setMoreError] = useState<{ base: GrowthRecord; text: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [measureType, setMeasureType] = useState<'1' | '2'>('1');
  const sex = data?.sex;
  const bandSex = sex === '1' || sex === '2' ? sex : null;
  const band = useAsync(async () => (bandSex ? api.growthBand(bandSex, measureType) : null), [bandSex, measureType]);

  if (page.loading) return <Loading />;
  if (page.error) return <ErrorBox text={page.error} />;
  if (!data) return null;

  const extra = more?.base === data ? more : null;
  const entries = extra ? [...data.achievements, ...extra.entries] : data.achievements;
  const next = extra ? extra.next : data.next_before;

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true); setMoreError(null);
    try {
      const r = await api.growthRecord(user!, childId, next);
      setMore({ base: data, entries: [...(extra?.entries ?? []), ...r.achievements], next: r.next_before });
    } catch (e) {
      setMoreError({ base: data, text: (e as Error).message });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="contact-page growth-page">
      <div className="contact-page-head">
        <Link className="btn btn-quiet btn-sm" to="/guardian"><BackIcon />ホームへ</Link>
        <h1>{data.child_name}の成長の記録</h1>
        {data.grace_ends_on && <p className="muted">{monthDay(data.grace_ends_on)}まで読むことができます</p>}
      </div>

      {data.share_physical && (
        <section className="card contact-section" aria-labelledby="growth-body-title">
          <div className="growth-section-head">
            <h2 id="growth-body-title">身長・体重</h2>
            <div className="growth-switch" role="group" aria-label="グラフの切り替え">
              {/* 【仮置き】選んでいる側は、トーナルの地（M3 の segmented button の secondary-container）に加えて ✓ の印（SelectedIcon）と太字で示す（色だけに頼らない。WCAG 1.4.1、GitHub Issue #211。web/仮置き値.md）。
                  印は読み上げない（選んでいることは aria-pressed で伝わる） */}
              <button type="button" className={measureType === '1' ? 'measure-toggle btn-tonal' : 'measure-toggle'} aria-pressed={measureType === '1'}
                onClick={() => setMeasureType('1')}>{measureType === '1' && <SelectedIcon />}身長</button>
              <button type="button" className={measureType === '2' ? 'measure-toggle btn-tonal' : 'measure-toggle'} aria-pressed={measureType === '2'}
                onClick={() => setMeasureType('2')}>{measureType === '2' && <SelectedIcon />}体重</button>
            </div>
          </div>
          {data.measurements.length === 0 ? (
            <p className="empty">{TEXT.growthNoMeasurement}</p>
          ) : !data.birth_date ? (
            <p className="muted">{TEXT.growthNoBirthDate}</p>
          ) : (
            <>
              {/* 性別が未回答なら帯を描かず折れ線だけにする（基本設計書「成長グラフの表示」(4-9)） */}
              <GrowthChart child={{ child_name: data.child_name, birth_date: data.birth_date }} records={data.measurements}
                standards={bandSex ? band.data ?? null : null} measureType={measureType} noBandText={TEXT.growthNoSex} />
              <p className="muted growth-source">{TEXT.growthSource}</p>
            </>
          )}
          {data.measurements.length > 0 && <MeasurementList rows={data.measurements} />}
        </section>
      )}

      <section className="card contact-section" aria-labelledby="growth-done-title">
        <h2 id="growth-done-title">できたこと</h2>
        {entries.length === 0
          ? <p className="empty">{TEXT.growthEmpty}</p>
          : <GrowthTimeline entries={entries} />}
        {moreError?.base === data && <ErrorBox text={moreError.text} />}
        {next && (
          <button type="button" className="contact-wide-button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? '読み込んでいます…' : 'さらに読み込む'}
          </button>
        )}
      </section>

      {/* 免責は身長・体重を出さないときも出し、画面の下端（緊急連絡の案内のすぐ上）に止める（詳細設計書 (2-11 (3))） */}
      <Disclaimer text={data.disclaimer} />
    </div>
  );
}
