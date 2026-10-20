/*
 * GLM に聞く（セキュリティレビューの所見をもらう）
 *
 * この環境の OpenCode に、無料で使える GLM（opencode/glm-5.3-flash-free）がある。
 * その CLI を非対話で呼び、返ってきた本文だけを取り出す。
 *
 * 呼び出しは `opencode run`（自動化向けの入口）。
 *   --standalone … ふだん使っている OpenCode のセッションを汚さないよう、専用のサーバで動かす
 *   --format json … 1 行ずつ JSON で返る。本文は type が "text" の行にある
 *   本文はコマンドラインではなく標準入力から渡す。コマンドラインの長さには上限があり
 *   （Windows は 32767 文字）、プローブが増えると当たるためである。
 *
 * 【仮置き】使うモデルと待ち時間。設計で決まった値ではない（web/仮置き値.md）。
 *
 * CLI が見つからないときは、GLM の工程だけを飛ばす（ハーネスの合否には響かせない）。
 * CI には OpenCode が無いため、その場合も静かに飛ばす。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/* 【仮置き】GLM のモデル。GLM_MODEL で差し替えられる */
export const MODEL = process.env.GLM_MODEL ?? 'opencode/glm-5.3-flash-free';

/* 【仮置き】GLM の応答を待つ上限（ミリ秒） */
const TIMEOUT_MS = Number(process.env.GLM_TIMEOUT_MS ?? 240_000);

/** 本文の長さの上限。大きくしすぎて費用や待ち時間が膨らむのを防ぐ安全弁 */
const MAX_PROMPT = 60_000;

export type GlmResult = { ok: true; model: string; text: string } | { ok: false; reason: string };

/** OpenCode の CLI を探す。OPENCODE_CLI が最優先 */
export function locateCli(): string | null {
  const explicit = process.env.OPENCODE_CLI;
  if (explicit) return existsSync(explicit) ? explicit : null;

  const name = 'opencode';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }

  // デスクトップ版には CLI が同梱されている（これが無い環境では飛ばす）
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bundled = path.join(process.env.LOCALAPPDATA, 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe');
    if (existsSync(bundled)) return bundled;
  }
  return null;
}

function textOf(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; part?: { type?: string; text?: string }; error?: unknown };
      if (event.type === 'text' && typeof event.part?.text === 'string') parts.push(event.part.text);
    } catch {
      // JSON でない行（進捗の表示など）は捨てる
    }
  }
  return parts.join('\n').trim();
}

/** GLM に 1 回だけ聞く。質問はそのまま 1 つのメッセージとして渡す */
export async function askGlm(prompt: string, cwd: string): Promise<GlmResult> {
  const cli = locateCli();
  if (!cli) {
    return { ok: false, reason: 'OpenCode の CLI が見つかりません（OPENCODE_CLI で場所を指定できます）' };
  }

  let input = prompt;
  if (input.length > MAX_PROMPT) {
    input = `${input.slice(0, MAX_PROMPT)}\n\n（長すぎるため、ここで切り詰めました）`;
  }

  const args = ['run', '--standalone', '--model', MODEL, '--format', 'json', '--title', 'security-review'];

  return new Promise<GlmResult>((resolve) => {
    const child = execFile(
      cli,
      args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const text = textOf(stdout);
        if (text) {
          resolve({ ok: true, model: MODEL, text });
          return;
        }
        const detail = (stderr || error?.message || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
        resolve({ ok: false, reason: detail || `GLM から本文が返りませんでした（${MODEL}）` });
      },
    );

    // 本文は標準入力から渡す（コマンドラインの長さの上限に当たらないため）
    if (!child.stdin) {
      child.kill();
      resolve({ ok: false, reason: 'CLI の標準入力を使えませんでした' });
      return;
    }
    // CLI が先に終わって書き込めないときも、上のコールバックで結果が返る
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}
