import { test, expect } from '@playwright/test';
import { auditLayout } from './audit';

test('[harness] 検出器がはみ出しを拾い、ラベルと表内スクロールを区別する', async ({ page }) => {
  await page.setContent(`<style>body{margin:0} main{width:240px;overflow:auto} button{width:2200px;height:44px}</style><main><button>はみ出す操作</button></main>`);
  let audit = await page.evaluate(auditLayout);
  expect(audit.findings.some((f) => f.rule === 'horizontal-overflow')).toBe(true);
  expect(audit.findings.some((f) => f.rule === 'clipped-control')).toBe(true);

  await page.setContent(`<style>body{margin:0}button{width:20px;height:20px;padding:0}label{display:inline-flex;width:80px;height:52px;align-items:center}input{position:absolute;width:1px;height:1px;opacity:0}</style><button>小</button><label><input type="radio">仰向け</label>`);
  audit = await page.evaluate(auditLayout);
  expect(audit.controlsChecked).toBe(2);
  expect(audit.findings.filter((f) => f.rule === 'small-target')).toHaveLength(1);
  expect(audit.findings.find((f) => f.rule === 'small-target')?.label).toBe('小');

  await page.setContent(`<style>body{margin:0}.card{width:240px;overflow-x:auto}table{width:1800px}button{width:80px;height:44px}</style><div class="card"><table><tr><td>横に送る表</td><td><button>編集</button></td></tr></table></div>`);
  audit = await page.evaluate(auditLayout);
  expect(audit.findings.some((f) => f.rule === 'scrollable-table')).toBe(true);
  expect(audit.findings.filter((f) => f.severity === 'error')).toEqual([]);

  await page.setContent(`<style>body{margin:0}.clip{width:240px;overflow:hidden}button{margin-left:250px;width:80px;height:44px}</style><div class="clip"><button>欠ける操作</button></div>`);
  audit = await page.evaluate(auditLayout);
  expect(audit.findings.some((f) => f.rule === 'clipped-control')).toBe(true);
});
