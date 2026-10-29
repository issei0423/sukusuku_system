/*
 * 午睡チェックの通知音（Web Audio で出す。外部の音声ファイルに頼らない）
 * 典拠：基本設計書「午睡チェックの実施」(4-8) の処理 4「次の確認の時刻になったら、通知音を伴って知らせる」、
 *   要件定義書「通知音を伴う例外」（園児の生命に関わる午睡チェックのタイマー・アラーム）・「タイマー・アラームの実現方式と運用前提」、
 *   図/画面詳細図「午睡チェック画面」(5-1) 項目3
 *
 * ブラウザは、画面を触る前の音を出させない。午睡チェックを開始する操作（押す）で使える状態にし、
 * 押さずに画面を開き直したとき（音が出る状態でないとき）は、タイマーの欄で触るよう伝える（NapCheckScreen）。
 * 端末のマナーモードを越えて鳴らすことは、画面からはできない。運用手順で担保する（要件定義書「午睡チェックの運用前提」）。
 *
 * 【仮置き】音の高さ・長さ・回数・大きさは設計が定めていない（web/仮置き値.md「午睡チェックの動き」）
 */
import { useCallback, useEffect, useState } from 'react';

/** 1回の知らせで鳴らす音の数。眠っている子を起こしすぎず、聞き逃しにくい数 */
const BEEPS = 3;
/** 音の高さ（Hz） */
const FREQUENCY = 880;
/** 1つの音の長さ・音の間（秒） */
const BEEP_SECONDS = 0.25;
const GAP_SECONDS = 0.15;
/** 大きさ（0〜1）。端末の音量を越えない */
const VOLUME = 0.4;

type AudioContextCtor = typeof AudioContext;
let context: AudioContext | null = null;
/** 音の状態（動いている・止められた）が変わったときに、画面へ知らせる先 */
const watchers = new Set<() => void>();

function contextCtor(): AudioContextCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

function ensureContext(): AudioContext | null {
  if (context) return context;
  const Ctor = contextCtor();
  if (!Ctor) return null;
  try {
    context = new Ctor();
    context.onstatechange = () => watchers.forEach((w) => w());
  } catch { context = null; }
  return context;
}

/** 音を鳴らせる状態か（このブラウザが Web Audio を持ち、止められていない） */
const running = () => context?.state === 'running';

/** ブラウザが、画面への操作を受けたことがあるか（無ければ、音の準備は操作を待つ） */
const hasBeenTouched = () => typeof navigator !== 'undefined'
  && (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive === true;

function resume(): Promise<void> {
  const ctx = ensureContext();
  if (!ctx) return Promise.resolve();
  return ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => undefined);
}

function schedule(ctx: AudioContext) {
  const start = ctx.currentTime + 0.02;
  for (let i = 0; i < BEEPS; i += 1) {
    const at = start + i * (BEEP_SECONDS + GAP_SECONDS);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = FREQUENCY;
    // 音の頭と終わりで急に切らない（ぷつっという雑音を避ける）
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.02);
    gain.gain.setValueAtTime(VOLUME, at + BEEP_SECONDS - 0.03);
    gain.gain.linearRampToValueAtTime(0, at + BEEP_SECONDS);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + BEEP_SECONDS);
  }
}

/**
 * 実施中の午睡チェック画面で、通知音を使える状態に保つ。
 * `ready` が false の間は、画面を触るまで鳴らせない（タイマーの欄で知らせる）。null は確かめている途中。`play` で 1 回分の通知音を鳴らす
 */
export function useNapSound(active: boolean) {
  const supported = !!contextCtor();
  // null は「まだ確かめていない」。確かめる前に「出る状態になっていません」を一瞬出さない（PR #322 の review）
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active || !supported) return;
    const sync = () => setReady(running());
    const unlock = () => { void resume().then(sync); };
    watchers.add(sync);
    // 触れたことがあれば、いま使える状態にする。無ければ、最初に触れるまで待つ
    if (hasBeenTouched()) unlock(); else sync();
    // 触るたびに確かめる。端末が音を止めた（iOS の割り込みなど）あとも、次に触れば戻る
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      watchers.delete(sync);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [active, supported]);

  const play = useCallback(() => {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'running') { schedule(ctx); return; }
    // 止められていても、もう一度試す（操作を受けたあとなら通る）
    void resume().then(() => { if (running()) schedule(ctx); });
  }, []);

  return { ready, supported, play };
}
