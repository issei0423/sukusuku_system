---
applyTo: "web/**/*.ts,web/**/*.tsx"
---

# 画面側（web/）

## データ層（`src/api/`）

- 画面は必ず `src/api/client.ts` から読む（`api`・`canSeeChild` など）。`http.ts`・`mock.ts` を画面から直接 import しない。
- `http.ts`（Go サーバへ問い合わせる。既定）と `mock.ts`（ブラウザ内のモック。`VITE_API=mock` のときとテスト）は、同じ関数名で同じ形を返す。形は `shapes.ts`・`types.ts` の 1 か所で決める。
- **`mock.ts` の規則は Go サーバの写し**。参照範囲（`canSeeChild`・`visibleChildren`・`canUseClass`）、権限、入力の検証、操作ログ（`log`）を変えたら、`server/` の同じ所も直す。相手側の場所はたいていコメントに書いてある（例：「サーバ側は server/scope.go の canUseClass」）。
- `http.ts` の関数は、引数で渡される利用者を使わない（`_u`・`_user` のように `_` を付けてある）。サーバがセッションから利用者を決めるため。モックは渡された `user` で判定する。どちらでも同じ結果になるようにする。
- モックは成功を `ok(value)`、失敗を `fail('…')` で返す。文言はサーバ（`writeForbidden`・`writeErr`）と同じにする。
- デモデータは `mockDb.ts`（サーバは `server/seed.sql`）。記録の配列を足したら、`mockDb.ts` の末尾の日付ずらし（`recordSets`）にも入れる。
- 日付・時刻は `util.ts` の `now()`・`today()`・`jstNow()`（JST）で作る。月齢は必ず `ageInMonths` で出す（応当日基準）。

## 仮置きの値

設計（`docs` ブランチの基本設計書）が決めていない値（色・間隔・件数・文言など）を置いたら、
`web/仮置き値.md` の近い表に「項目・仮置き・置いた場所」を足し、コードに `【仮置き】` とコメントする。
設計で決まっている値（タップ領域 44px、ページングの件数など）は仮置きにしない。仮置き値.md は設計の決定ではない。

## 画面

- 画面は `src/screens/<機能>/`（auth・chat・diary・growth・master・nap）、共通の部品は `src/components/`、外枠は `src/layouts/`。
- 画面は名前で呼ぶ（「園児一覧画面」）。画面 ID を新しく振らない。
- 色と寸法は `src/styles/tokens.css` の変数を使う。
- 利用者に見せる文言に、設計書の章番号を出さない（#144）。
- 画面の出し分けは操作性のため。権限の担保にはならないので、隠すだけで済ませず `server/` でも止める。

## テスト（`tests/`）

- `npm test`（`vitest run`）。`vitest.config.ts` が `VITE_API=mock` にするので、**テストの相手はモック**。サーバ側の規則はこれでは確かめられないので、Go 側にもテストを足す。
- 画面を描くテスト（`.tsx`）は、1 行目に `// @vitest-environment jsdom` が要る（既定は node）。
- `mockDb` の中身は同じファイルのテストどうしで使い回され、前のテストが変えた状態が残る。件数を決め打ちせず、前のテストの書き込みを当てにしない。
- 時刻に頼るテストは時計を固定する。`tests/screens.test.tsx` の書き方：

  ```ts
  beforeEach(() => {
    const day = today();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${day}T13:30:00+09:00`));
  });
  afterEach(() => { vi.useRealTimers(); });
  ```

- 結合テスト（`tests/integration.test.ts`）は `SUKUSUKU_API` を渡したときだけ走る。
- ファイルの先頭のコメントに典拠を書く（例：`典拠：基本設計書.md「権限と利用可能機能」(6-1)`）。`describe`・`it` の名前は日本語。
- `npm run lint`（oxlint）と `npm run build`（`tsc -b` つき）も通す。
