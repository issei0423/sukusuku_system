/**
 * お金の上限（Budget）と、実行の記録（RunLog）。記録には秘密を書かない（redact）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { MIN_CALL_USD } from './config.ts';

// ───────────────────────── お金の上限 ─────────────────────────

/**
 * 1回の実行と1件の上限。SDK の maxBudgetUsd を1回の query() ごとに渡し（その query の上限）、
 * 結果の total_cost_usd を足していって、残りが無ければ次へ進まない。
 * total_cost_usd はクライアント側の見積もりで、上限を少し越えることがある（SDK の文書「maxBudgetUsd」）。
 */
export class Budget {
  spent = 0;
  constructor(
    readonly maxUsd: number,
    readonly perItemUsd: number,
  ) {}

  remaining(): number {
    return Math.max(0, this.maxUsd - this.spent);
  }

  /** 新しい件を始めてよいか */
  canStartItem(): boolean {
    return this.remaining() >= MIN_CALL_USD;
  }

  /** この件で、次の query() に渡す上限。0 なら呼ばない */
  capForCall(itemSpent: number): number {
    const cap = Math.min(this.perItemUsd - itemSpent, this.remaining());
    return cap >= MIN_CALL_USD ? round(cap) : 0;
  }

  add(usd: number): void {
    if (Number.isFinite(usd) && usd > 0) this.spent += usd;
  }
}

const round = (n: number) => Math.floor(n * 100) / 100;
export const usd = (n: number) => `$${n.toFixed(2)}`;

// ───────────────────────── 秘密を伏せる ─────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic の API キー
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub のトークン
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
];

/** 記録に書く前に、秘密らしい文字と、環境変数の秘密の値そのものを伏せる */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 12 && /(KEY|TOKEN|SECRET|PASSWORD)/.test(k)) out = out.split(v).join('[伏せた]');
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[伏せた]');
  return out;
}

// ───────────────────────── 実行の記録 ─────────────────────────

export type ItemKind = 'issue' | 'pr' | 'task';

const kindName = (k: ItemKind) => (k === 'issue' ? 'Issue' : k === 'pr' ? 'PR' : 'task');

export interface ItemRecord {
  kind: ItemKind;
  number: number;
  title: string;
  outcome: string;
  url?: string;
  costUsd: number;
  notes: string[];
}

/** いまの時刻（ローカル、+09:00 などの差つき） */
export function localIso(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

export function stamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class RunLog {
  readonly name: string;
  readonly summaryPath: string;
  readonly jsonlPath: string;
  /** CI のログなど、この実行の細かいものの置き場 */
  readonly dir: string;
  readonly items: ItemRecord[] = [];
  readonly skipped: { kind: ItemKind; number: number; reason: string }[] = [];
  readonly notes: string[] = [];
  readonly denials: string[] = [];
  stopReason: string | undefined;
  private readonly started = new Date();

  constructor(
    runsDir: string,
    readonly commandLine: string,
    command: string,
    readonly header: string[],
  ) {
    this.name = `${stamp(this.started)}-${command}`;
    fs.mkdirSync(runsDir, { recursive: true });
    this.summaryPath = path.join(runsDir, `${this.name}.md`);
    this.jsonlPath = path.join(runsDir, `${this.name}.jsonl`);
    this.dir = path.join(runsDir, this.name);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** メッセージの流れを1行ずつ（秘密は伏せる） */
  event(item: string, msg: unknown): void {
    const line = JSON.stringify({ t: localIso(), item, msg });
    fs.appendFileSync(this.jsonlPath, redact(line) + '\n', 'utf8');
  }

  note(text: string): void {
    this.notes.push(redact(text));
  }

  render(budget?: Budget): string {
    const lines: string[] = [];
    lines.push(`# api-agent の実行（${this.name}）`, '');
    lines.push(`- コマンド：\`${this.commandLine}\``);
    for (const h of this.header) lines.push(`- ${h}`);
    lines.push(`- 始めた：${localIso(this.started)}・終えた：${localIso()}`);
    if (budget) lines.push(`- 使った額：${usd(budget.spent)}（SDK の見積もり。上限は1回 ${usd(budget.maxUsd)}・1件 ${usd(budget.perItemUsd)}）`);
    lines.push(`- 止まったわけ：${this.stopReason ?? 'なし（最後まで回った）'}`, '');

    lines.push(`## 扱ったもの（${this.items.length} 件）`, '');
    if (this.items.length === 0) lines.push('なし', '');
    else {
      lines.push('| 種類 | 番号 | 題 | 結果 | 費用 | URL |', '| :-- | :-- | :-- | :-- | :-- | :-- |');
      for (const it of this.items) {
        lines.push(`| ${kindName(it.kind)} | ${it.kind === 'task' ? '-' : `#${it.number}`} | ${cell(it.title)} | ${cell(it.outcome)} | ${usd(it.costUsd)} | ${it.url ?? ''} |`);
      }
      lines.push('');
      for (const it of this.items.filter((i) => i.notes.length > 0)) {
        lines.push(`### ${kindName(it.kind)} ${it.kind === 'task' ? it.title : `#${it.number}`}`, ...it.notes.map((n) => `- ${n}`), '');
      }
    }
    lines.push(`## 飛ばしたもの（${this.skipped.length} 件）`, '');
    lines.push(...(this.skipped.length ? this.skipped.map((s) => `- ${kindName(s.kind)} #${s.number}：${s.reason}`) : ['なし']), '');
    if (this.notes.length) lines.push('## メモ', '', ...this.notes.map((n) => `- ${n}`), '');
    if (this.denials.length) lines.push(`## 守りで断った道具の呼び出し（${this.denials.length} 回）`, '', ...this.denials.map((d) => `- ${d}`), '');
    lines.push(`メッセージの流れ：\`${path.basename(this.jsonlPath)}\`・細かいログ：\`${path.basename(this.dir)}/\``, '');
    return redact(lines.join('\n'));
  }

  write(budget?: Budget): string {
    const text = this.render(budget);
    fs.writeFileSync(this.summaryPath, text, 'utf8');
    return text;
  }
}

const cell = (s: string) => s.replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
