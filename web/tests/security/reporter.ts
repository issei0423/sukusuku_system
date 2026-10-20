/*
 * セキュリティレビュー・ハーネスのレポーター
 *
 * 実行結果を集めて
 *   1. security-report/results.json … 機械が読む形
 *   2. GLM に所見と追加の攻撃案を聞く（glm.ts。CLI が無ければ飛ばす）
 *   3. security-report/index.html … 人が読む形
 * を書く。レスポンシブレビューのレポーターと同じ流儀（tests/responsive/reporter.ts）。
 *
 * GLM の所見は、合否には使わない。合否を決めるのはプローブの判定だけである
 * （AI の答えは揺れる。人が読むための材料として載せる）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FullResult, Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';
import { askGlm, locateCli, MODEL } from './glm';
import { ANNOTATION, type Attempt, type ProbeResult, type Verdict } from './probes';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const VERDICT_LABEL: Record<Verdict, string> = { ok: '守られていた', ng: '守られていなかった', info: '記録のみ' };
const GUARD_LABEL: Record<string, string> = { true: '守られていた', false: '守られていなかった', null: '判定しない' };

/** GLM の返事を、そのまま読める形へ。見出しと箇条書きだけを扱う */
function markdown(text: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const inline = (s: string) =>
    escape(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*・]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (bullet) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
    } else if (numbered) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

/** GLM に渡す質問。結果だけを渡し、判定はプローブに任せてある */
function buildPrompt(results: ProbeResult[]): string {
  const blocks = results.map((r) => {
    const lines = r.attempts.map((a: Attempt) => {
      const guard = a.guarded === null ? '判定しない' : GUARD_LABEL[String(a.guarded)];
      const detail = a.detail ? `（${a.detail}）` : '';
      return `- 試したこと: ${a.what} ／ 結果: ${a.result} ／ この試み: ${guard}${detail}`;
    });
    return [
      `### [${r.id}] ${r.title}`,
      `観点: ${r.category} ／ 守られていなかったときの重さ: ${r.severity} ／ このプローブの判定: ${VERDICT_LABEL[r.verdict]}`,
      `典拠: ${r.basis}`,
      `なぜ大事か: ${r.why}`,
      ...lines,
    ].join('\n');
  });

  return `あなたは、保育園の業務システム（すくすくシステム。Go + React で作ったモックアップ）の
セキュリティレビューを頼まれた担当者です。下の「攻撃ケースの実行結果」を読んで、日本語で所見をまとめてください。

## 前提として知っておくこと
- 権限の担保はサーバ側で行う。画面の出し分けは操作性のためであり、担保ではない（基本設計書「権限チェックの実装方針」(6-2)）。
- 参照範囲: 管理者は全園児、一般職員は自クラス、保護者は有効な紐づけのある自児のみ。
- ログイン中の上書きログインは成立させない。停止したアカウントのセッションはその場で切る。
- 状態を変える要求は Origin（無ければ Referer）を確かめ、どちらも無ければ拒否する。
- 演習の動作検証環境は localhost のため、Cookie の Secure は false、HSTS も付かない。これは設計どおりである。
- 実行結果は、攻撃者がブラウザや curl で直接 API を叩いた場合を想定している。

## 攻撃ケースの実行結果
${blocks.join('\n\n')}

## 書いてほしいこと
次の見出しを、この順番と名前のまま使って Markdown で書いてください。

## 総評
（3〜5 行。いちばん気になる点を先に）

## 気になる実行結果
（1 件 1 項目。対象の [id]、重大度を「高・中・低」で、なぜ気になるかを書く。
  判定が「守られていた」ものでも、気になるものは挙げてよい。無ければ「なし」）

## 追加で試すとよい攻撃
（このハーネスに足すとよいプローブの案。1 件 1 項目で、
  「誰として（デモアカウント）」「どの API を」「どう叩くか」「何が起きたら守られていないと判断するか」を書く。3〜6 件）

## 確かめていないこと
（上の結果からは分からないこと。推測を断定で書かないこと）

守られていなかった（判定: 守られていなかった）ものは、いちばん重く扱ってください。`;
}

/** GLM の所見。得られなかったときもレポートに理由を残す */
type GlmSection =
  | { status: 'ok'; model: string; text: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string };

export default class SecurityReporter implements Reporter {
  private results: ProbeResult[] = [];
  private runErrors: string[] = [];
  private out = path.resolve('security-report');

  onBegin() {
    mkdirSync(this.out, { recursive: true });
  }

  onError(error: TestError) {
    this.runErrors.push(error.message ?? String(error.value));
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const annotation = test.annotations.find((a) => a.type === ANNOTATION);
    if (!annotation?.description) {
      if (result.status !== 'passed') this.runErrors.push(`${test.title}: ${result.error?.message ?? '実行できませんでした'}`);
      return;
    }
    try {
      this.results.push(JSON.parse(annotation.description) as ProbeResult);
    } catch {
      this.runErrors.push(`${test.title}: 実行結果を読み取れませんでした`);
    }
  }

  async onEnd(result: FullResult) {
    const counts = { ok: 0, ng: 0, info: 0 };
    for (const r of this.results) counts[r.verdict]++;

    const glm = await this.askGlm();

    mkdirSync(this.out, { recursive: true });
    writeFileSync(
      path.join(this.out, 'results.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status: result.status,
          model: MODEL,
          counts,
          runErrors: this.runErrors,
          glm,
          probes: this.results,
        },
        null,
        2,
      ),
    );
    writeFileSync(path.join(this.out, 'index.html'), this.render(result, counts, glm));
    console.error(
      `[security] レポートを書きました: ${path.join(this.out, 'index.html')}（守られていた ${counts.ok} / 守られていなかった ${counts.ng} / 記録のみ ${counts.info}）`,
    );
  }

  private async askGlm(): Promise<GlmSection> {
    if (process.env.SECURITY_GLM === '0') return { status: 'skipped' as const, reason: 'SECURITY_GLM=0 のため飛ばしました' };
    if (!locateCli()) return { status: 'skipped' as const, reason: 'OpenCode の CLI が見つからないため飛ばしました（CI では飛ばします）' };
    if (this.results.length === 0) return { status: 'skipped' as const, reason: '実行できたプローブがないため飛ばしました' };

    console.error(`[security] GLM（${MODEL}）に所見を問い合わせています。少し待ちます…`);
    const res = await askGlm(buildPrompt(this.results), process.cwd());
    if (!res.ok) return { status: 'error' as const, reason: res.reason };
    return { status: 'ok' as const, model: res.model, text: res.text };
  }

  private render(result: FullResult, counts: { ok: number; ng: number; info: number }, glm: GlmSection) {
    const order: Verdict[] = ['ng', 'ok', 'info'];
    const sorted = [...this.results].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.id.localeCompare(b.id));

    const cards = sorted
      .map((r) => {
        const attempts = r.attempts
          .map(
            (a) =>
              `<li class="${a.guarded === false ? 'bad' : a.guarded === null ? 'note' : ''}"><b>${escape(a.what)}</b><br><code>${escape(a.result)}</code><span class="guard">${escape(GUARD_LABEL[String(a.guarded)])}</span>${a.detail ? `<p class="detail">${escape(a.detail)}</p>` : ''}</li>`,
          )
          .join('');
        return `<article data-verdict="${r.verdict}"><h2><span class="badge ${r.verdict}">${escape(VERDICT_LABEL[r.verdict])}</span> ${escape(r.title)} <small>${escape(r.id)}</small></h2>
        <p class="meta">観点: ${escape(r.category)} · 重さ: ${escape(r.severity)} · 典拠: ${escape(r.basis)}</p>
        <p class="why">${escape(r.why)}</p>
        <ul class="attempts">${attempts}</ul></article>`;
      })
      .join('');

    const glmHtml =
      glm.status === 'ok'
        ? `<section class="glm"><h2>GLM の所見 <small>${escape(glm.model ?? '')}・合否には使っていない</small></h2>${markdown(glm.text ?? '')}</section>`
        : `<section class="glm skipped"><h2>GLM の所見</h2><p>今回は飛ばしました: ${escape(glm.reason ?? '')}</p></section>`;

    return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>セキュリティレビュー</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;background:#f4f4f1;color:#242424;line-height:1.7}header,section,article{max-width:1000px}h1{font-size:26px}h2{font-size:19px}small{font-weight:400;color:#555}article{background:white;padding:20px;border:1px solid #ccc;margin-bottom:20px}article[data-verdict="ng"]{border-left:6px solid #ad3328}.badge{font-size:12px;padding:2px 8px;border-radius:10px;background:#ddd}.badge.ng{background:#ad3328;color:#fff}.badge.ok{background:#3d7a44;color:#fff}.badge.info{background:#a47212;color:#fff}.meta{color:#555;font-size:13px}.why{font-size:14px}ul.attempts{list-style:none;padding:0;margin:0}ul.attempts li{border-left:3px solid #bbb;padding:8px 12px;margin:8px 0;font-size:14px}ul.attempts li.bad{border-color:#ad3328;background:#fdf2f1}ul.attempts li.note{border-color:#a47212}code{background:#f0f0ec;padding:1px 4px;font-size:13px}.guard{font-size:12px;color:#555;margin-left:8px}.detail{color:#555;font-size:13px;margin:4px 0 0}section.glm{background:white;padding:20px;border:1px solid #ccc}section.glm.skipped{color:#555}pre{white-space:pre-wrap;color:#a22}input{padding:10px;font:inherit}</style>
<header><h1>セキュリティレビュー（ハーネス）</h1>
<p>実行状態: ${escape(result.status)} · プローブ ${this.results.length} 件 · <b>守られていなかった ${counts.ng}</b> · 守られていた ${counts.ok} · 記録のみ ${counts.info} · 実行できなかった ${this.runErrors.length}</p>
<p>相手は、ハーネス自身が使い捨てのデータベースで起動したサーバである。手元の開発サーバや本番には向けていない。
プローブの期待は「守るべき姿」で書いてあり、守られていなかったものはテストも落ちる（<code>SECURITY_REPORT_ONLY=1</code> で落とさず見られる）。</p>
<p><label>絞り込み <input type="search" id="q" placeholder="id・観点・文言"></label></p>
${this.runErrors.length ? `<section class="glm"><h2>実行できなかったもの</h2><ul>${this.runErrors.map((e) => `<li><code>${escape(e)}</code></li>`).join('')}</ul></section>` : ''}
${glmHtml}
${cards}
<section class="glm"><h2>この結果で確かめられていないこと</h2>
<ul>
<li>セッションの無操作による自動失効（30 分）は待てないため試していない。</li>
<li>HTTPS で公開したときの Cookie の Secure 属性と HSTS は、localhost のため試していない。</li>
<li>画面（React）側の XSS。ここで見ているのは API の応答だけである。入力がそのまま HTML として描かれるかは、画面側のテストで見る。</li>
<li>操作ログ（誰が何をしたか）の内容。記録の有無と参照範囲は別のテストが見ている。</li>
<li>同時に多数の要求を送ったときの挙動（総当たりの速度、資源の使い切り）。</li>
<li>GLM の所見と追加の攻撃案は AI の答えであり、正しさは確かめていない。人が読んで、必要ならプローブとして足す。</li>
</ul></section>
<footer><p>生成: ${escape(new Date().toISOString())}${glm.status === 'ok' ? ` · GLM: ${escape(glm.model ?? '')}` : ''}</p></footer>
<script>
const q = document.getElementById('q');
q.addEventListener('input', () => {
  const needle = q.value.trim().toLowerCase();
  for (const card of document.querySelectorAll('article')) {
    card.hidden = needle !== '' && !card.textContent.toLowerCase().includes(needle);
  }
});
</script>
</html>`;
  }
}
