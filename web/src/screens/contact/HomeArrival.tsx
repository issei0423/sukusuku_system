/*
 * 「家庭から」が届いたことを、読み上げへ伝える欄（画面に1つの role="status"）
 * 典拠：詳細設計書「全画面に共通する部品と決まり」(2-0) の (6)「読み上げの範囲」の②（決めたこと D-57）、
 *      WCAG 4.1.3 ステータスメッセージ、GitHub Issue #209
 *
 * 連絡帳（クラス）画面・連絡帳（園児）画面は、保護者が送ると知らせ（live.ts）を受けて表ごと読み直す。
 * 「家庭から」のある園児が増えたときだけ「家庭からが1件届きました（〇〇さん）」と入れる（見つけ方は useHomeArrival.ts）。
 * 欄は見えない（目で見ている人は表の「未確認」で気づける）。同じ文が続いても読まれるよう、入れるたびに中身を差し替える
 */
export default function HomeArrivalStatus({ said }: { said: { text: string; seq: number } | null }) {
  return (
    <div className="sr-only" role="status" data-home-arrival="">
      {said && <span key={said.seq}>{said.text}</span>}
    </div>
  );
}
