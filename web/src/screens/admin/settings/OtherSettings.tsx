/*
 * 設定画面の「そのほかの設定値」の区画（管理者）
 * 典拠：詳細設計書「設定画面（管理者）」(2-14 (7))・「設定ごとの検査」(4-10 (3))、基本設計書「設定マスタ（m_setting）」(5-9)
 *
 * ほかの区画に無い設定を表で並べる（列は名前・いまの値・既定値・説明。設定キーは名前の下に小さく添える）。
 * 行ごとの入れ方と検査は 4-10 (3) の表による（サーバが検査する。入力中の値は残し、誤りは行の近くに出す）。
 * 画面から変えないもの（添付の形式など）は、値を読むだけの行として出し、理由を添える。
 * 保存は画面の「保存する」（SettingsForm）。午睡のチェック間隔を既定より長くするときは確認の窓で注意する（止めない）。
 */
import { useId } from 'react';
import type { SectionProps } from './SettingsForm';
import { OTHER_SETTINGS, READ_ONLY_SETTINGS } from './settingsLabels';

function EditRow({ settingKey, description, view, values, set, error, busy }: SectionProps & { settingKey: string; description: string }) {
  const id = useId();
  const label = OTHER_SETTINGS[settingKey];
  const row = view.settings.find((s) => s.setting_key === settingKey)!;
  const failed = error?.field === settingKey;
  return (
    <tr>
      <th scope="row">
        <label htmlFor={id}>{label.label}</label>
        <small className="muted settings-key"><code>{settingKey}</code></small>
      </th>
      <td>
        {/* 数の欄は spinbutton、文字・小数・カンマ区切りは textbox。入れ方の目安は欄の説明にする */}
        <input id={id} type={label.kind === 'int' ? 'number' : 'text'} inputMode={label.kind === 'text' ? 'text' : label.kind === 'int' ? 'numeric' : 'decimal'}
          step={label.kind === 'int' ? 1 : undefined} value={values[settingKey] ?? ''} disabled={busy}
          aria-describedby={`${id}-hint`} aria-invalid={failed || undefined}
          onChange={(e) => set(settingKey, e.target.value)} />
        {label.unit && <span className="settings-unit"> {label.unit}</span>}
        <p className="muted" id={`${id}-hint`}>{label.hint}</p>
        {failed && <p className="contact-error" role="alert">{error!.message}</p>}
      </td>
      <td>{row.default_value === '' ? '（園が入力）' : `${row.default_value}${label.unit ? ` ${label.unit}` : ''}`}</td>
      <td>{description}</td>
    </tr>
  );
}

export default function OtherSettings(props: SectionProps) {
  const rows = props.view.settings.filter((s) => s.group === 'other');
  return (
    <section className="card settings-section" aria-labelledby="settings-other-title">
      <h2 id="settings-other-title">そのほかの設定値</h2>
      {/* 【仮置き】区画の説明（web/仮置き値.md） */}
      <p className="muted">園の名称・午睡のチェック間隔・ログインや画面の時間・身体測定のしきい値・一覧の件数など、ほかの区画に無い設定です。変えるとすぐ、その値を使う画面と処理に効きます。</p>
      <table className="list settings-table">
        <caption className="sr-only">そのほかの設定値の一覧</caption>
        <thead>
          <tr><th scope="col">名前</th><th scope="col">いまの値</th><th scope="col">既定値</th><th scope="col">説明</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const ro = READ_ONLY_SETTINGS[s.setting_key];
            if (!s.editable) {
              const r = ro ?? { label: s.setting_key, reason: '画面からは変えません。' };
              return (
                <tr key={s.setting_key}>
                  <th scope="row">{r.label}<small className="muted settings-key"><code>{s.setting_key}</code></small></th>
                  <td>{s.setting_value}</td>
                  <td>{s.default_value}</td>
                  <td>{r.reason}</td>
                </tr>
              );
            }
            return <EditRow key={s.setting_key} {...props} settingKey={s.setting_key} description={s.description} />;
          })}
        </tbody>
      </table>
    </section>
  );
}
