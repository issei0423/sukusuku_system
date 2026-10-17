---
description: '業務の規則（権限・参照範囲・入力の検証など）を、Go サーバと画面側のモックの両方へ同じように入れる'
agent: 'agent'
argument-hint: '変える規則（例：午睡の体温も、身体記録と同じく想定の範囲の外なら確かめてから記録する）'
---

次の規則を、すくすくシステムの **Go サーバ（`server/`）と画面側のモック（`web/src/api/mock.ts`）の両方**に入れてください。
片方だけだと食い違います（`MOCKUP.md`、`web/仮置き値.md`「業務の規則を2か所に持っていること」）。

- 規則：${input:rule:変える規則を一文で}
- 典拠（分かれば）：${input:basis:例 基本設計書「入力項目の制約値」(4-9)、Issue #142}

## 進め方

1. **典拠を確かめる。** `git fetch origin docs` のあと `git show origin/docs:基本設計書.md` で該当の項目を探す（要件は `要件定義書.md`、画面の動きは `図/画面詳細図.md`）。
   設計が決めていないところは推測で決めない。決まっていないと報告し、仮に置くなら `web/仮置き値.md` に足す。
2. **いまの実装を両側で探す。** サーバは `server/routes.go` から該当のハンドラへ。モックは `web/src/api/mock.ts` の同じ名前の関数へ。相手側の場所はたいていコメントに書いてある。
3. **両方を直す。** 判定の順番・境界（以上か、より大きいか）・拒否の文言をそろえる。
   - サーバは入口の `requireUser` / `requireStaff` / `requireAdmin` に加えて、`canSeeChild` / `canUseClass` / `visibleDiaryCondition` で範囲を確かめる。
   - 状態を変える操作なら、操作ログも両方に残す（サーバ `a.log`、モック `log`）。
   - 返す形を変えるなら `web/src/api/shapes.ts`・`types.ts` と `web/src/api/http.ts` も。
4. **コメントに典拠を書く。** 名前を主に、番号はカッコで：`基本設計書「入力項目の制約値」(4-9)`。Issue があれば番号も。
5. **テストを両方に足す。** 通る場合と、拒否される・弾かれる場合の両方。
   - Go：`server/*_test.go`。`newTestApp` と `loginAs` を使う（`server/api_dashboard_test.go` にある。作り直さない）。
   - モック：`web/tests/` の近いファイル。
6. **確かめる。**
   - `cd server && go vet ./... && go test ./...`
   - `cd web && npm test && npm run lint && npm run build`
7. **報告する。** サーバとモックそれぞれで変えた所、足したテスト、典拠、**確かめていないこと**（結合テスト `npm run test:integration` を回していない、など）。
