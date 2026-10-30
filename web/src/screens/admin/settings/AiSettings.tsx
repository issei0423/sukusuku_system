/*
 * 設定画面の AI の区画（管理者）
 * 典拠：詳細設計書「設定画面（管理者）」(2-14 (1)(5))・「設定」(4-10)・「キーが無い・無効・有効にしていないときの画面」(8-8)、
 *      基本設計書「園の有効化と保護者の拒否」(4-11)・「外部の AI へ送る情報」(6-3)
 *
 * 「AI の下書きを使う」の切り替え（既定は使わない）と、1日の上限回数（1〜10000 の整数）。保存は画面の「保存する」（SettingsForm）。
 * 有効にするときの確認（「プライバシーポリシーに外部の AI へ送ることを書いた版を…」）は SettingsForm の確認の窓に添える。
 * サーバに API キーがあるか・無効と分かったかを示す（キーそのものは画面に出さない）。
 */
import { useId } from 'react';
import { AI_TEXT } from '../../../messages';
import { Alert } from '../../../components/ui';
import type { SectionProps } from './SettingsForm';

const ENABLED_TEXT: Record<string, string> = { '0': '使わない', '1': '使う' };

export default function AiSettings({ view, values, set, error, busy }: SectionProps) {
  const limitId = useId();
  const enabled = values['ai.enabled'] || '0';
  return (
    <section className="card settings-section" aria-labelledby="settings-ai-title">
      <h2 id="settings-ai-title">AI の下書き</h2>
      {/* 【仮置き】区画の説明（web/仮置き値.md） */}
      <p className="muted">連絡帳の「園から」と「活動のひとこと」で、文の下書きを外部の AI（Claude）で作れるようにします。下書きは担任が直してから送ります。</p>

      {!view.ai_key_present && <Alert soft>{AI_TEXT.noKey}</Alert>}
      {view.ai_key_present && view.ai_key_rejected && <Alert>{AI_TEXT.keyRejected}</Alert>}

      <fieldset className="settings-field">
        <legend>AI の下書きを使う</legend>
        <div className="settings-choices">
          {(['0', '1'] as const).map((v) => (
            <label key={v} className="settings-choice">
              <input type="radio" name="ai-enabled" value={v} checked={enabled === v} disabled={busy}
                onChange={() => set('ai.enabled', v)} />
              {ENABLED_TEXT[v]}
            </label>
          ))}
        </div>
        {/* 【仮置き】キーが無いあいだに有効にしたときの添え書き（web/仮置き値.md。詳細設計書 (8-8) の「有効にしても使えない旨を添える」） */}
        {!view.ai_key_present && enabled === '1' && <p className="muted">API キーが無いあいだは、有効にしても使えません。</p>}
        {error?.field === 'ai.enabled' && <p className="contact-error" role="alert">{error.message}</p>}
      </fieldset>

      <div className="settings-field">
        <label htmlFor={limitId}>1日の上限回数（園全体）</label>
        <input id={limitId} type="number" inputMode="numeric" min={1} max={10000} step={1} value={values['ai.daily_limit'] ?? ''} disabled={busy}
          aria-invalid={error?.field === 'ai.daily_limit' || undefined}
          onChange={(e) => set('ai.daily_limit', e.target.value)} />
        {/* 【仮置き】上限の説明（web/仮置き値.md） */}
        <p className="muted">上限に達すると、その日は下書きを作らずに、その旨を出します。</p>
        {error?.field === 'ai.daily_limit' && <p className="contact-error" role="alert">{error.message}</p>}
      </div>
    </section>
  );
}
