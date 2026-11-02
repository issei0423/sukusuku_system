/*
 * 設定画面の連絡帳の区画（管理者）
 * 典拠：詳細設計書「設定画面（管理者）」(2-14 (2))・「設定ごとの検査」(4-10 (3))、基本設計書「出す項目と選択肢の設定」(4-5)、決めたこと D-42
 *
 * 保護者へ出すきょうのようすの項目（0個でもよい）・「家庭から」の項目（1つ以上）・排せつときげんの選択肢（1つ以上、1つ1〜20文字、
 * カンマを含めない、重ねない、つないで100文字以内）。「家庭から」「園から」は一覧に置かない（外せない）。
 * 保存は画面の「保存する」（SettingsForm）。保護者へは知らせない。
 */
import { useId } from 'react';
import type { SectionProps } from './SettingsForm';
import { HOME_ITEMS, SHOW_ITEMS } from './settingsLabels';
import { AddIcon } from '../../../components/icons';

/** カンマ区切りの設定のうち、選ぶ項目のチェックボックス */
function ItemChecks({ title, settingKey, items, values, set, error, busy, note }: SectionProps & {
  title: string; settingKey: string; items: [string, string][]; note: string;
}) {
  const chosen = (values[settingKey] ?? '').split(',').filter(Boolean);
  const toggle = (key: string, on: boolean) => {
    // 並びは項目の決まった順にそろえる
    set(settingKey, items.map((i) => i[0]).filter((k) => (k === key ? on : chosen.includes(k))).join(','));
  };
  return (
    <fieldset className="settings-field">
      <legend>{title}</legend>
      <div className="settings-choices">
        {items.map(([key, name]) => (
          <label key={key} className="settings-choice">
            <input type="checkbox" checked={chosen.includes(key)} disabled={busy} onChange={(e) => toggle(key, e.target.checked)} />
            {name}
          </label>
        ))}
      </div>
      <p className="muted">{note}</p>
      {error?.field === settingKey && <p className="contact-error" role="alert">{error.message}</p>}
    </fieldset>
  );
}

/** 選択肢の並び：1つずつの入力欄と「＋」「×」「上へ」「下へ」（長押しやドラッグだけにしない） */
function ChoiceList({ title, settingKey, values, set, error, busy, note }: SectionProps & { title: string; settingKey: string; note: string }) {
  const id = useId();
  const list = (values[settingKey] ?? '').split(',');
  const write = (next: string[]) => set(settingKey, next.join(','));
  const move = (i: number, d: number) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    write(next);
  };
  return (
    <fieldset className="settings-field" aria-describedby={`${id}-note`}>
      <legend>{title}</legend>
      <ol className="settings-choice-list">
        {list.map((v, i) => (
          <li key={i}>
            {/* カンマは区切りに使うため入れられない。改行も入れない（入力欄は1行） */}
            <input type="text" aria-label={`${title} ${i + 1}`} value={v} disabled={busy} maxLength={20}
              aria-invalid={error?.field === settingKey || undefined}
              onChange={(e) => write(list.map((x, j) => (j === i ? e.target.value.replace(/[,\r\n]/g, '') : x)))} />
            {/* 選択肢ごとにくり返す操作なので、枠のないテキストボタンにする（r2c-03） */}
            <button type="button" className="btn-quiet" disabled={busy || i === 0} aria-label={`${title} ${i + 1} を上へ`} onClick={() => move(i, -1)}>上へ</button>
            <button type="button" className="btn-quiet" disabled={busy || i === list.length - 1} aria-label={`${title} ${i + 1} を下へ`} onClick={() => move(i, 1)}>下へ</button>
            <button type="button" className="btn-quiet" disabled={busy || list.length === 1} aria-label={`${title} ${i + 1} を消す`} onClick={() => write(list.filter((_, j) => j !== i))}>×</button>
          </li>
        ))}
      </ol>
      <div><button type="button" disabled={busy} onClick={() => write([...list, ''])}><AddIcon />足す</button></div>
      <p className="muted" id={`${id}-note`}>{note}</p>
      {error?.field === settingKey && <p className="contact-error" role="alert">{error.message}</p>}
    </fieldset>
  );
}

export default function ContactSettings(props: SectionProps) {
  return (
    <section className="card settings-section" aria-labelledby="settings-contact-title">
      <h2 id="settings-contact-title">連絡帳</h2>
      <ItemChecks {...props} title="保護者へ出すきょうのようすの項目" settingKey="contact.show_items" items={SHOW_ITEMS}
        note="出すかは保護者が開いた時点の設定で決まります。戻すと過去の分も出ます。出さない項目も職員は記録でき、日誌の下書きに入ります。" />
      <ItemChecks {...props} title="「家庭から」の項目" settingKey="contact.home_items" items={HOME_ITEMS}
        note="1つ以上選んでください（「家庭から」は外せません）。" />
      <ChoiceList {...props} title="排せつの選択肢" settingKey="contact.toilet_choices"
        note="1つ1〜20文字、つないで100文字以内。カンマは入れられません。健康の判定を含む言葉（「下痢」「元気」など）は入れないでください。選んだ時点の文字が記録に残るため、変えても過去の記録は変わりません。" />
      <ChoiceList {...props} title="きげんの選択肢" settingKey="contact.mood_choices"
        note="1つ1〜20文字、つないで100文字以内。カンマは入れられません。健康の判定を含む言葉（「下痢」「元気」など）は入れないでください。選んだ時点の文字が記録に残るため、変えても過去の記録は変わりません。" />
    </section>
  );
}
