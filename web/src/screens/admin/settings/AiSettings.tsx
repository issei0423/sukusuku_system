/*
 * 設定画面の AI の区画（管理者）
 * 典拠：詳細設計書「設定画面（管理者）」(2-14 (1)(5))・「設定」(4-10)・「キーが無い・無効・有効にしていないときの画面」(8-8)、
 *      基本設計書「園の有効化と保護者の拒否」(4-11)・「外部の AI へ送る情報」(6-3)
 *
 * 「AI の下書きを使う」の切り替え（既定は使わない）と、1日の上限回数（1〜10000 の整数）を、区画の「保存する」でまとめて保存する。
 * 保存の前に確認のダイアログで変更の前後を並べ、有効にするときは「プライバシーポリシーに外部の AI へ送ることを書いた版を施行してから
 * 有効にしてください」を添える。サーバに API キーがあるか・無効と分かったかを示す（キーそのものは画面に出さない）。
 * 誤りは入力欄の近くに出し、入力中の値は残す。ほかの管理者が先に変えていたら（409）親（SettingsScreen）が読み直す。
 */
import { useId, useState } from 'react';
import { api } from '../../../api/client';
import type { SettingsView } from '../../../api/shapes';
import { useSession } from '../../../session';
import { useUnsavedInput } from '../../../unsavedInput';
import { AI_TEXT } from '../../../messages';
import { Alert } from '../../../components/ui';
import { ConfirmDialog } from '../../../components/feedback';

const valueOf = (v: SettingsView, key: string) => v.settings.find((s) => s.setting_key === key)?.setting_value ?? '';
const ENABLED_TEXT: Record<string, string> = { '0': '使わない', '1': '使う' };

export default function AiSettings({ view, onSaved, onEdit, onConflict }: {
  view: SettingsView;
  onSaved: (v: SettingsView) => void;
  onEdit: () => void;
  /** ほかの管理者が先に変えていた。文言を渡して読み直してもらう */
  onConflict: (message: string) => void;
}) {
  const { user } = useSession();
  const limitId = useId();
  const before = { enabled: valueOf(view, 'ai.enabled') || '0', limit: valueOf(view, 'ai.daily_limit') };
  const [enabled, setEnabled] = useState(before.enabled);
  const [limit, setLimit] = useState(before.limit);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const dirty = before.enabled !== enabled || before.limit !== limit;
  useUnsavedInput(dirty);

  const changes: Record<string, string> = {};
  if (before.enabled !== enabled) changes['ai.enabled'] = enabled;
  if (before.limit !== limit) changes['ai.daily_limit'] = limit.trim();

  const save = async () => {
    setBusy(true); setError(null);
    try {
      onSaved(await api.saveSettings(user!, changes, view.read_at));
    } catch (e) {
      const err = e as Error & { kind?: string; field?: string };
      setBusy(false); setConfirming(false);
      if (err.kind === 'version_conflict') onConflict(err.message);
      else setError({ message: err.message, field: err.field });
    }
  };

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
                onChange={() => { setEnabled(v); onEdit(); }} />
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
        <input id={limitId} type="number" inputMode="numeric" min={1} max={10000} step={1} value={limit} disabled={busy}
          aria-invalid={error?.field === 'ai.daily_limit' || undefined}
          onChange={(e) => { setLimit(e.target.value); onEdit(); }} />
        {/* 【仮置き】上限の説明（web/仮置き値.md） */}
        <p className="muted">上限に達すると、その日は下書きを作らずに、その旨を出します。</p>
        {error?.field === 'ai.daily_limit' && <p className="contact-error" role="alert">{error.message}</p>}
      </div>

      {error && !error.field && <p className="contact-error" role="alert">{error.message}</p>}
      <div className="contact-composer-actions">
        <button type="button" className="btn-primary" disabled={!dirty || busy} onClick={() => { setError(null); setConfirming(true); }}>保存する</button>
      </div>

      {confirming && (
        <ConfirmDialog title="設定を保存しますか" confirmLabel={busy ? '保存しています…' : '保存する'} busy={busy}
          onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
          <ul className="settings-diff">
            {before.enabled !== enabled && <li>AI の下書きを使う：{ENABLED_TEXT[before.enabled]} → {ENABLED_TEXT[enabled]}</li>}
            {before.limit !== limit && <li>1日の上限回数：{before.limit} → {limit.trim()}</li>}
          </ul>
          {before.enabled !== '1' && enabled === '1' && <Alert soft>{AI_TEXT.enableConfirm}</Alert>}
        </ConfirmDialog>
      )}
    </section>
  );
}
