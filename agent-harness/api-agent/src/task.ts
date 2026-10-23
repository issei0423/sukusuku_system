/**
 * task：任意の頼みの文を1つ走らせる（全体テストの区画など）。
 * push はしない（allowPush は常に false）。ほかの守り（マージ・force・削除・秘密）は src/safety.ts がそのまま効く。
 */
import fs from 'node:fs';
import path from 'node:path';
import { protectedDirsFor, runAgent, type AgentContext } from './agent.ts';
import type { Args, TaskArgs } from './args.ts';
import { redact, usd, type Budget, type ItemRecord } from './report.ts';
import { isInside, type SafetyContext } from './safety.ts';

/** 頼みの文の頭から出す行数（--dry-run） */
export const DRY_RUN_PROMPT_LINES = 40;

export function readTaskPrompt(file: string): string {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`頼みの文のファイルが無い：${file}`);
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (text.trim() === '') throw new Error(`頼みの文のファイルが空：${file}`);
  return text;
}

/** --cwd・--allow-dir・--out の置き場を調べる。断るわけの一覧（無ければ空） */
export function checkTaskPlaces(
  t: Pick<TaskArgs, 'cwd' | 'allowDirs' | 'out'>,
  protectedDirs: string[],
  platform: SafetyContext['platform'],
): string[] {
  const ctx = { platform } as SafetyContext;
  const problems: string[] = [];
  const overlap = (what: string, dir: string) => {
    for (const p of protectedDirs) {
      if (isInside(dir, p, ctx) || isInside(p, dir, ctx)) problems.push(`${what} ${dir} が守りのフォルダ ${p} と重なる`);
    }
  };
  overlap('--cwd', t.cwd);
  for (const d of t.allowDirs) overlap('--allow-dir', d);
  if (t.out && ![t.cwd, ...t.allowDirs].some((d) => isInside(t.out!, d, ctx))) {
    problems.push(`--out ${t.out} が --cwd・--allow-dir の中にない`);
  }
  return problems;
}

export function taskLabel(t: Pick<TaskArgs, 'label' | 'promptFile'>): string {
  return t.label ?? path.basename(t.promptFile);
}

/** 記録のファイル名に使える形にする */
export function safeLabel(s: string): string {
  return 'task-' + (s.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x');
}

/** 場所の検査（フォルダがあるか・守りと重ならないか）。問題の一覧（無ければ空） */
export function validateTask(t: TaskArgs, roots: { mainRoot: string; repoRoot: string }): string[] {
  const problems: string[] = [];
  const dirs: [string, string][] = [['--cwd', t.cwd], ...t.allowDirs.map((d): [string, string] => ['--allow-dir', d])];
  for (const [what, dir] of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) problems.push(`${what} のフォルダが無い：${dir}`);
  }
  problems.push(...checkTaskPlaces(t, protectedDirsFor(roots), process.platform === 'win32' ? 'win32' : 'posix'));
  return problems;
}

export function dryRunText(args: Args, prompt: string): string {
  const t = args.task!;
  const lines = prompt.split(/\r?\n/);
  return [
    '--dry-run（API は呼ばない）',
    `label：${taskLabel(t)}`,
    `cwd：${t.cwd}`,
    `allow-dir：${t.allowDirs.length ? t.allowDirs.join('、') : 'なし'}`,
    `out：${t.out ?? 'なし'}`,
    `上限：1回 ${usd(args.maxUsd)}・1件 ${usd(args.perItemUsd)}・往復 ${t.maxTurns}・${t.timeoutMin} 分・effort ${args.effort}`,
    'push：しない',
    `頼みの文（頭 ${DRY_RUN_PROMPT_LINES} 行・全 ${lines.length} 行）：`,
    '────────',
    ...lines.slice(0, DRY_RUN_PROMPT_LINES),
    '────────',
  ].join('\n');
}

export async function runTask(args: Args, budget: Budget, ctx: AgentContext): Promise<void> {
  const t = args.task!;
  const label = taskLabel(t);
  const rec: ItemRecord = {
    kind: 'task',
    number: 0,
    title: label,
    outcome: '',
    costUsd: 0,
    notes: [`cwd：${t.cwd}`, `allow-dir：${t.allowDirs.join('、') || 'なし'}`],
  };
  ctx.log.items.push(rec);
  console.log(`\n■ task ${label}`);
  const cap = budget.capForCall(0);
  if (cap === 0) {
    rec.outcome = '飛ばした（上限の残りが無い）';
    return;
  }
  const prompt = readTaskPrompt(t.promptFile);
  const res = await runAgent(
    {
      kind: 'task',
      label: safeLabel(label),
      prompt,
      cwd: t.cwd,
      maxUsd: cap,
      maxTurns: t.maxTurns,
      timeoutMin: t.timeoutMin,
      effort: args.effort,
      allowPush: false,
      allowGhWrite: false,
      extraDirs: t.allowDirs,
    },
    ctx,
  );
  budget.add(res.costUsd);
  rec.costUsd = res.costUsd;
  rec.outcome = `${res.ok ? '済んだ' : '止めた'}（${res.subtype}・${res.turns} 往復）`;
  rec.notes.push(...res.errors.map((e) => `エージェント：${e}`));
  if (!res.ok) ctx.log.stopReason = `task が成功で終わらなかった（${res.subtype}）`;
  if (res.resultText) rec.notes.push(`最後の文の頭：${redact(res.resultText.slice(0, 300).replace(/\s+/g, ' '))}`);
  if (t.out) {
    try {
      fs.mkdirSync(path.dirname(t.out), { recursive: true });
      fs.writeFileSync(t.out, redact(res.resultText || '（最後の文は無かった）') + '\n', 'utf8');
      rec.notes.push(`最後の文を書いた：${t.out}`);
    } catch (e) {
      rec.notes.push(`--out に書けなかった：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`  → ${rec.outcome}（${usd(rec.costUsd)}）`);
}
