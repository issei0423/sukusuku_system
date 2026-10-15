import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase, TestResult, FullResult, FullConfig, Suite, TestError } from '@playwright/test/reporter';
import type { Audit } from './audit';
import type { Scenario } from './scenarios';

interface Entry {
  project: string;
  title: string;
  status: string;
  error?: string;
  audit?: Audit & { scenario: Scenario };
  images: { name: string; file: string }[];
}
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export default class ReviewReporter implements Reporter {
  private entries: Entry[] = [];
  private out = path.resolve('responsive-report');
  private expected = 0;
  private runErrors: string[] = [];
  onBegin(_config: FullConfig, suite: Suite) {
    this.expected = suite.allTests().length;
    mkdirSync(path.join(this.out, 'captures'), { recursive: true });
  }
  onError(error: TestError) { this.runErrors.push(error.message ?? String(error.value)); }
  onTestEnd(test: TestCase, result: TestResult) {
    const entry: Entry = { project: test.parent.project()?.name ?? '', title: test.title, status: result.status, error: result.error?.message, images: [] };
    const audit = result.attachments.find((a) => a.name === 'layout-audit');
    if (audit) entry.audit = JSON.parse((audit.body ?? readFileSync(audit.path!)).toString());
    for (const attachment of result.attachments.filter((a) => a.contentType === 'image/png')) {
      const file = `captures/${entry.project}-${entry.audit?.scenario.id ?? test.id.replace(/[^\w-]/g, '')}-${attachment.name.replace(/[^\w-]/g, '')}.png`;
      if (attachment.body) writeFileSync(path.join(this.out, file), attachment.body);
      else if (attachment.path) copyFileSync(attachment.path, path.join(this.out, file));
      else continue;
      entry.images.push({ name: attachment.name, file });
    }
    this.entries.push(entry);
  }
  onEnd(result: FullResult) {
    mkdirSync(this.out, { recursive: true });
    this.entries.sort((a, b) => a.title.localeCompare(b.title) || a.project.localeCompare(b.project));
    const counts = { error: 0, review: 0, info: 0 };
    for (const entry of this.entries) for (const f of entry.audit?.findings ?? []) counts[f.severity]++;
    const incomplete = Math.max(0, this.expected - this.entries.length) + this.entries.filter((e) => e.status !== 'passed' || (!e.audit && !e.title.startsWith('[harness]'))).length;
    writeFileSync(path.join(this.out, 'results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), status: result.status, expected: this.expected, counts, incomplete, runErrors: this.runErrors, entries: this.entries }, null, 2));
    const cards = this.entries.map((e) => {
      const findings = e.audit?.findings ?? [];
      const needsReview = findings.some((f) => f.severity !== 'info');
      const selfCheck = e.title.startsWith('[harness]');
      return `<article data-issue="${needsReview || e.status !== 'passed' || (!e.audit && !selfCheck)}"><h2>${escape(e.audit?.scenario.name ?? e.title)} <small>${escape(e.project)}</small></h2>
        <p>${escape(e.audit?.scenario.path ?? '')} · 実行 ${escape(e.status)} · ${e.audit ? `操作領域 ${e.audit.controlsChecked}件 / 指摘 ${findings.filter((f) => f.severity !== 'info').length}件` : selfCheck ? '検出器の自己検証' : '検査未完了'}</p>
        ${e.error ? `<pre>${escape(e.error)}</pre>` : ''}
        <div class="images">${e.images.map((img) => `<a href="${escape(img.file)}" target="_blank"><img loading="lazy" src="${escape(img.file)}" alt="${escape(img.name)}"><span>${escape(img.name)}</span></a>`).join('')}</div>
        <details${needsReview ? ' open' : ''}><summary>検査結果 (${findings.length})</summary>
        ${findings.map((f) => `<div class="finding ${f.severity}"><b>${escape(f.severity)} · ${escape(f.rule)}</b><p>${escape(f.label)} — ${escape(f.detail)}</p><code>${escape(f.selector)}</code></div>`).join('') || (selfCheck ? '<p>意図的にはみ出し・小さいボタン・ラベル・表内スクロールを作り、検出結果を検証します。</p>' : '<p>自動検査による指摘なし。画像の目視確認は必要です。</p>')}</details></article>`;
    }).join('');
    writeFileSync(path.join(this.out, 'index.html'), `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>レスポンシブレビュー</title>
      <style>body{font-family:system-ui,sans-serif;margin:24px;background:#f4f4f1;color:#242424}header{max-width:1000px;margin-bottom:24px}h1{font-size:26px}h2{font-size:19px}small{font-weight:400;color:#555}input{padding:10px;font:inherit}article{background:white;padding:20px;border:1px solid #ccc;margin-bottom:20px}article[hidden]{display:none}.images{display:flex;gap:16px;overflow:auto}.images a{flex:0 0 240px;display:grid;gap:6px}.images img{width:240px;height:210px;object-fit:contain;object-position:top;background:#eee;border:1px solid #ddd}details{margin-top:16px}.finding{border-left:4px solid #aaa;padding:12px;margin:12px 0;overflow-wrap:anywhere}.error{border-color:#ad3328}.review{border-color:#a47212}code{font-size:12px}pre{white-space:pre-wrap;color:#a22}button{min-height:44px;font:inherit}label{display:inline-block;padding:12px}</style>
      <header><h1>レスポンシブレビュー</h1><p>実行状態: ${escape(result.status)} · ${this.entries.length} / ${this.expected}ケース · 構造的な指摘 ${counts.error} · 要目視 ${counts.review} · 参考 ${counts.info} · 実行未完了／失敗 ${incomplete}</p>
      ${this.runErrors.map((error) => `<pre>${escape(error)}</pre>`).join('')}
      <p>画像は実際のアプリの CSS とデモデータを使用。画面上端と内部スクロールの下端を記録します。指摘数は要素ごとの件数で、同じ原因を重複して数える場合があります。</p>
      <p>WebKit による iPad / スマホのエミュレーションです。実機の持ち方、指の届きやすさ、ソフトウェアキーボード、描画の細部は実機で確認してください。</p>
      <input id="search" type="search" placeholder="画面名・端末・ルールで絞る" aria-label="絞り込み"><label><input id="issues" type="checkbox"> 指摘・実行失敗のあるケースだけ</label>
      <p><a href="results.json">機械可読 JSON</a> · <a href="html/index.html">Playwright 詳細レポート</a></p></header>${cards}
      <script>const search=document.querySelector('#search'),issues=document.querySelector('#issues');function filter(){for(const a of document.querySelectorAll('article'))a.hidden=!a.textContent.toLowerCase().includes(search.value.toLowerCase())||(issues.checked&&a.dataset.issue!=='true')}search.addEventListener('input',filter);issues.addEventListener('change',filter)</script></html>`);
    console.log(`\nレスポンシブレビュー: ${path.join(this.out, 'index.html')}\n構造的な指摘 ${counts.error} / 要目視 ${counts.review} / 実行未完了・失敗 ${incomplete}`);
  }
}
