/*
 * セキュリティレビュー・ハーネスの本体
 *
 * プローブ（probes.ts）を 1 つずつ実行し、結果をレポーターへ渡す。
 * 判定は probes.ts が返す Attempt の guarded で決まる。
 *
 * 守られていなかった（guarded: false）ときはテストを落とす。CI で回すのは、
 * 「前に守れていたものが守れなくなった」ことに気づくためである。
 * 記録だけで判定しない観点（セキュリティヘッダーなど）は落とさない。
 *
 * SECURITY_REPORT_ONLY=1 を付けると、落とさずにレポートだけを作る。
 * 初めて回して、いまどこがどうなっているかを見たいときに使う。
 */
import { test, expect } from '@playwright/test';
import { ANNOTATION, PROBES, verdictOf, type Attempt } from './probes';

const reportOnly = process.env.SECURITY_REPORT_ONLY === '1';

test.describe.configure({ mode: 'serial' });

for (const probe of PROBES) {
  test(`[${probe.id}] ${probe.title}`, async () => {
    const attempts = await probe.run();
    const verdict = verdictOf(attempts);

    test.info().annotations.push({
      type: ANNOTATION,
      description: JSON.stringify({
        id: probe.id,
        title: probe.title,
        category: probe.category,
        severity: probe.severity,
        basis: probe.basis,
        why: probe.why,
        attempts,
        verdict,
      }),
    });

    if (reportOnly) return;

    expect(violations(attempts)).toEqual([]);
  });
}

function violations(attempts: Attempt[]): string[] {
  return attempts
    .filter((a) => a.guarded === false)
    .map((a) => `${a.what} → ${a.result}${a.detail ? `（${a.detail}）` : ''}`);
}
