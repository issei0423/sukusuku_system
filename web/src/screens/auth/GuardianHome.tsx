/*
 * 保護者ホーム
 * 典拠：基本設計書.md「画面の一覧」(3-2)「自児の情報とチャットへの導線」、
 *      詳細設計書「保護者ホーム（「きょう」）」(2-5)、基本設計書「保護者ホームの『きょう』」(3-5)
 *
 * 開いている園児の「きょう」の区画（日付・園児名・連絡帳の要約と未読。contact/TodayCard.tsx）を置く。
 * お子さまが2人以上なら、日付の下に名前のタブを出して切り替える（縦に全部積まない）。選んだお子さまは画面をまたいで保ち、
 * 下のタブの「連絡帳」「成長」の行き先になる。
 * 「ねた」「おきた」などは、園が記録した時点で知らせ（contact）を受けて読み直す。
 * 日誌は園内の記録で、保護者へ共有しない。以前の「共有された記録」（日誌へのリンク）の区画は外した
 * （詳細設計書「日誌の画面（作り直し）」(2-13 (1))）。保護者へは連絡帳の「きょう」で届ける。
 *
 * 「きょう」だけを置く。連絡帳・成長・チャットへの入口の行は置かず、画面の下のタブから行く（layouts/GuardianLayout.tsx）。
 * 園からの配布物は、チャットツールの一部なので（要件定義書「チャットツール」(4-4)）、チャット・お知らせの画面から開く。
 * 職員がチャット画面から配布物を開くのと同じ形にそろえた。
 *
 * 【仮置き】見た目は紙の連絡帳に寄せ、箱で囲まず罫線で区切る。上の小さい見出し（「保護者ページ」「お子さま」など）と
 * 「こんにちは」の前置きは置かない（web/仮置き値.md「保護者の画面の見た目」）。
 */
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAsync, AUTO_REFRESH_MS } from '../../hooks';
import { onLive } from '../../live';
import { useSession } from '../../session';
import { api } from '../../api/client';
import { Loading, ErrorBox, Empty, Alert } from '../../components/ui';
import { ACCOUNT_CHANGED_TEXT } from '../../messages';
import { formatAge, today } from '../../api/util';
import TodayCard from '../contact/TodayCard';
import { useGuardianChild } from '../../guardianChild';

export default function GuardianHome() {
  const { user } = useSession();
  // お子さまが2人以上のときに、いま開いている子（園児の ID）。画面をまたいで保つ（layouts/GuardianLayout.tsx）。選んでいなければ先頭
  const { childId: selected, setChildId, reportContactNew } = useGuardianChild();
  const accountChanged = (useLocation().state as { accountChanged?: boolean } | null)?.accountChanged === true;
  /*
   * 開いたままでも、連絡帳（家庭からの確認・ねた・おきた・きょうのようす）・チャットの未読・発達と身体測定が
   * すぐに表れるよう、知らせ（live.ts）を受けて読み直す（詳細設計書「画面ごとの読み直し」(6-5)）。
   * 午睡（nap）・日誌（diary）の知らせは保護者へ届かない（詳細設計書「PR #196 からの変更」(6-1)）
   */
  const { data, error, loading } = useAsync(() => api.guardianHome(user!), [user?.account_id],
    { refreshMs: AUTO_REFRESH_MS, live: onLive('contact', 'chat', 'development', 'physical') });

  // いま開いている園児。お子さまが2人以上のときは名前のタブで切り替える（縦に全部積まない）。選んでいる子がいなくなったら先頭に戻す
  const current = data?.find((x) => x.child.child_id === selected) ?? data?.[0];
  const currentId = current?.child.child_id ?? '';

  /*
   * 画面を開いたとき（表示した最初と、タブを前に出したとき）に、開いている園児の今日のページを開いた時刻を残す。
   * 知らせを受けた読み直しでは残さない（決めたこと D-23）。開く前からの新しいものの数を持っておき、
   * 開いている間に届いたものと足して「新しく n 件」に出す。
   * お子さまが2人以上のときは、名前のタブで開いた子だけを残す（開いていない子の新しいものを、見ないまま消さない）
   */
  const before = useRef<Record<string, number>>({});
  /** 開いた時刻を残したときに出していた応答（園児ごと）。これより後の応答は、残したあとに届いたものだけを数える */
  const markedData = useRef<Record<string, unknown>>({});
  const latestData = useRef(data);
  latestData.current = data;
  const newCount = (shown: unknown, childId: string, current: number) => {
    const base = before.current[childId];
    if (base === undefined) return current;
    return shown === markedData.current[childId] ? base : base + current;
  };
  // 開いている園児の「新しく n 件」を、下のタブの「連絡帳」に字で添えるため、レイアウトへ知らせる
  const shownNew = current ? newCount(data, currentId, current.today.unread_contact) : 0;
  useEffect(() => {
    if (currentId) reportContactNew(currentId, shownNew);
  }, [currentId, shownNew, reportContactNew]);
  useEffect(() => {
    if (!user || !data || !currentId) return;
    const mark = () => {
      const shown = latestData.current;
      const h = shown?.find((x) => x.child.child_id === currentId);
      if (!shown || !h) return;
      before.current[currentId] = newCount(shown, currentId, h.today.unread_contact);
      void api.markContactRead(user, currentId, today()).catch(() => undefined);
      markedData.current[currentId] = shown;
    };
    if (before.current[currentId] === undefined) mark();
    const onVisible = () => { if (document.visibilityState === 'visible') mark(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // 開いている園児が変わったときだけ付け直す（読み直しのたびに付け直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.account_id, currentId]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox text={error} />;
  if (!data) return null;

  if (data.length === 0) {
    return <Empty text="お子さまの紐づけがありません。園へお問い合わせください。" />;
  }

  const h = current ?? data[0];

  const switcher = data.length > 1 && (
    <div className="guardian-child-tabs" role="group" aria-label="お子さまの切り替え">
      {data.map((x) => (
        <button type="button" key={x.child.child_id} aria-pressed={x.child.child_id === h.child.child_id}
          onClick={() => setChildId(x.child.child_id)}>{x.child.child_name}</button>
      ))}
    </div>
  );

  return (
    <div className="guardian-home">
      {/* 別のタブで別のアカウントにログインし直されたため、このタブも切り替えたとき（App.tsx） */}
      {accountChanged && <Alert soft>{ACCOUNT_CHANGED_TEXT}</Alert>}
      {/* 園児1人の「きょう」（詳細設計書 (2-5)）。行き先（連絡帳・成長・チャット・配布物）は、画面の下のタブから */}
      <TodayCard today={h.today} switcher={switcher} ageText={formatAge(h.child.birth_date, today())} />

      {/* 緊急の連絡は電話で行う。通知の到達性には限界がある（利用規約 第4条） */}
      <p className="guardian-contact-note">
        急なご連絡は、チャットではなくお電話でお願いします。
        チャットの通知は、端末の設定や通信の状況により届かない場合があります。
      </p>
    </div>
  );
}
