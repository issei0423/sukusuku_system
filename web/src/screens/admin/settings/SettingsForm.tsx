/*
 * 設定画面の入力（連絡帳・AI・そのほかの設定値の区画を1つの入力にまとめる）
 * 典拠：詳細設計書「設定画面（管理者）」(2-14 (1))・「設定」(4-10 (2))、決めたこと D-15・D-46
 *
 * 区画ごとに「保存する」を置かず、画面に「保存する」を1つだけ置く。変えた区画のキーをまとめて1回の POST /api/settings で送り、
 * 1つでも誤りがあれば何も書かない（4-10 (2)）。保存の前に確認のダイアログで変更の前後を並べる。
 * 有効にするときは「プライバシーポリシーに…」（AI）、午睡のチェック間隔を既定より長くするときは東京都の通知の注意を添える（止めない）。
 * 誤りは入力欄の近くに出し、入力中の値は残す。ほかの管理者が先に変えていたら（409）親（SettingsScreen）が読み直す。
 */
import { useState } from 'react';
import { api } from '../../../api/client';
import type { SettingsView } from '../../../api/shapes';
import { useSession } from '../../../session';
import { useUnsavedInput } from '../../../unsavedInput';
import { AI_TEXT, SETTINGS_TEXT } from '../../../messages';
import { Alert } from '../../../components/ui';
import { ConfirmDialog } from '../../../components/feedback';
import ContactSettings from './ContactSettings';
import AiSettings from './AiSettings';
import OtherSettings from './OtherSettings';
import { describeSetting } from './settingsLabels';
import { SaveIcon } from '../../../components/icons';

export interface SettingsError { message: string; field?: string }

/** 区画に渡すもの。values はキーごとの入力中の値、set で書き換える */
export interface SectionProps {
  view: SettingsView;
  values: Record<string, string>;
  set: (key: string, value: string) => void;
  error: SettingsError | null;
  busy: boolean;
}

const NAP_INTERVAL_KEYS = ['nap.interval_minutes.age0', 'nap.interval_minutes.age1', 'nap.interval_minutes.age2'];

export default function SettingsForm({ view, onSaved, onEdit, onConflict }: {
  view: SettingsView;
  onSaved: (v: SettingsView) => void;
  onEdit: () => void;
  /** ほかの管理者が先に変えていた。文言を渡して読み直してもらう */
  onConflict: (message: string) => void;
}) {
  const { user } = useSession();
  const saved: Record<string, string> = {};
  for (const s of view.settings) if (s.editable) saved[s.setting_key] = s.setting_value;
  const [values, setValues] = useState(saved);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SettingsError | null>(null);

  const changedKeys = Object.keys(saved).filter((k) => values[k].trim() !== saved[k]);
  const dirty = changedKeys.length > 0;
  useUnsavedInput(dirty);

  const set = (key: string, value: string) => { setValues((v) => ({ ...v, [key]: value })); onEdit(); };
  /** 送る値。数や文字の欄は前後の空白を落とす（サーバは空白を許さない） */
  const changes: Record<string, string> = {};
  for (const k of changedKeys) changes[k] = values[k].trim();

  const rowOf = (key: string) => view.settings.find((s) => s.setting_key === key);
  const longInterval = NAP_INTERVAL_KEYS.some((k) => {
    if (!(k in changes)) return false;
    const def = Number(rowOf(k)?.default_value);
    return Number(changes[k]) > def;
  });
  const enabling = saved['ai.enabled'] !== '1' && changes['ai.enabled'] === '1';

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

  const section: SectionProps = { view, values, set, error, busy };
  return (
    <>
      <ContactSettings {...section} />
      <AiSettings {...section} />
      <OtherSettings {...section} />

      {error && !error.field && <p className="contact-error" role="alert">{error.message}</p>}
      <div className="contact-composer-actions settings-save">
        <button type="button" className="btn-primary" disabled={!dirty || busy} onClick={() => { setError(null); setConfirming(true); }}><SaveIcon />保存する</button>
      </div>

      {confirming && (
        <ConfirmDialog title="設定を保存しますか" confirmLabel={busy ? '保存しています…' : '保存する'} confirmIcon={<SaveIcon />} busy={busy}
          onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
          <ul className="settings-diff">
            {changedKeys.map((k) => {
              const before = describeSetting(k, saved[k]);
              const after = describeSetting(k, changes[k]);
              return <li key={k}>{before.label}：{before.value} → {after.value}</li>;
            })}
          </ul>
          {enabling && <Alert soft>{AI_TEXT.enableConfirm}</Alert>}
          {longInterval && <Alert soft>{SETTINGS_TEXT.longInterval}</Alert>}
        </ConfirmDialog>
      )}
    </>
  );
}
