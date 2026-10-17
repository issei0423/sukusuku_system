/*
 * 家庭からを書く・直す（保護者・朝・選ぶだけ・任意）
 * 典拠：詳細設計書「家庭からを書く」(2-6 (3))、図/画面詳細図「連絡帳画面」(8-3)、基本設計書「家庭からの記入」(4-5)
 *
 * 項目は園が contact.home_items で選んだものだけを出す。どれも任意で、選ぶだけで送れる
 * （朝ごはん・きげん・送るで3タップ）。文字を打たなくても届けられる。
 * 押したらサーバの応答を待って結果を出す（楽観的更新をしない。決めたこと D-3）。
 * 送れなかったときは入力を残し、何が違うかと次にすることを出す。
 */
import { useState } from 'react';
import type { ContactHome, ContactHomeInput, MealAmount } from '../../api/shapes';
import { settingText } from '../../api/client';
import { useUnsavedInput } from '../../unsavedInput';
import { MEAL_AMOUNT_TEXT, TEXT } from '../../messages';
import { useReachable } from '../../api/reachability';
import TemperaturePicker from '../../components/TemperaturePicker';

/** 基本設計書「設定マスタ」(5-9) の既定（サーバの defaultHomeItems と同じ） */
const DEFAULT_HOME_ITEMS = 'temperature,night_sleep,breakfast,mood,pickup,message';
const MESSAGE_MAX = 500;
const PICKUP_PERSON_MAX = 50;
/** お迎えの人の選択肢（詳細設計書 (2-6 (3))。その他は文字で） */
const PICKUP_PEOPLE = ['母', '父', '祖母', '祖父'];

/** 10分刻みの時刻（from〜to 時） */
function times(fromHour: number, toHour: number): string[] {
  const out: string[] = [];
  for (let h = fromHour; h <= toHour; h++) {
    for (let m = 0; m < 60; m += 10) {
      if (h === toHour && m > 0) break;
      out.push(`${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return out;
}

function list(key: string, fallback: string): string[] {
  return settingText(key, fallback).split(',').map((v) => v.trim()).filter(Boolean);
}

function ChoiceGroup<T extends string>({ legend, name, value, options, onChange }: {
  legend: string; name: string; value: T | null; options: readonly (readonly [T, string])[]; onChange: (v: T) => void;
}) {
  return (
    <fieldset className="nap-choice-field contact-choice-field">
      <legend>{legend}</legend>
      <div className="nap-choice-options contact-choice-options">
        {options.map(([v, label]) => (
          <label key={v} className="nap-choice">
            <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function HomeForm({ home, busy, error, onSubmit, onCancel }: {
  /** 直すときは送った値。初めてなら null */
  home: ContactHome | null;
  busy: boolean;
  /** 送れなかった理由（入力を残したまま、近くに出す） */
  error: string | null;
  onSubmit: (input: ContactHomeInput) => void;
  onCancel?: () => void;
}) {
  const items = list('contact.home_items', DEFAULT_HOME_ITEMS);
  const moods = list('contact.mood_choices', '');
  const [temperature, setTemperature] = useState<number | null>(home?.temperature ?? null);
  const [temperatureOpen, setTemperatureOpen] = useState(false);
  const [sleepFrom, setSleepFrom] = useState(home?.night_sleep_from ?? '');
  const [sleepTo, setSleepTo] = useState(home?.night_sleep_to ?? '');
  const [breakfast, setBreakfast] = useState<MealAmount | null>(home?.breakfast ?? null);
  const [mood, setMood] = useState<string | null>(home?.mood_label ?? null);
  const [pickupType, setPickupType] = useState<'1' | '2' | null>(home?.pickup_type ?? null);
  const [pickupPerson, setPickupPerson] = useState(home?.pickup_person ?? '');
  const [pickupOther, setPickupOther] = useState(!!home?.pickup_person && !PICKUP_PEOPLE.includes(home.pickup_person));
  const [pickupTime, setPickupTime] = useState(home?.pickup_time ?? '');
  const [message, setMessage] = useState(home?.message ?? '');
  const [dirty, setDirty] = useState(false);
  useUnsavedInput(dirty);
  // サーバに届かないときは「もう一度送る」にする。入力は残す（詳細設計書「押したときの処理の型」(2-0 (2))）
  const reachable = useReachable();
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  const submit = () => {
    onSubmit({
      temperature,
      night_sleep_from: sleepFrom || null,
      night_sleep_to: sleepTo || null,
      breakfast,
      mood_label: mood,
      pickup_type: pickupType,
      pickup_person: pickupType === '2' ? pickupPerson.trim() || null : null,
      pickup_time: pickupType === '2' ? pickupTime || null : null,
      message: message.trim() || null,
      updated_at: home?.updated_at ?? null,
    });
  };

  return (
    <form className="contact-home-form" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-busy={busy}>
      {home?.confirmed_at && <p className="muted">{TEXT.homeResendNote}</p>}
      {items.includes('temperature') && (
        <div className="contact-field">
          <span>体温</span>
          {/* 一覧（35.0〜39.9℃）を 36.5 の位置から開き、値を押す（2タップ）。判定はしない（詳細設計書 (2-6 (3))） */}
          <div className="contact-temp-row">
            {temperature !== null && <strong className="contact-temp-value">{temperature.toFixed(1)}℃</strong>}
            <button type="button" className="contact-pick" onClick={() => setTemperatureOpen(true)}>
              {temperature === null ? '体温を入れる' : '入れ直す'}
            </button>
            {temperature !== null && <button type="button" className="btn-quiet" onClick={() => touch(setTemperature)(null)}>体温を消す</button>}
          </div>
          {temperatureOpen && (
            <TemperaturePicker title="体温" start={null} onClose={() => setTemperatureOpen(false)}
              onSelect={(v) => { touch(setTemperature)(v); setTemperatureOpen(false); }} />
          )}
        </div>
      )}
      {items.includes('night_sleep') && (
        <div className="contact-field-row">
          <label className="contact-field">
            <span>夜に寝た時刻</span>
            <select value={sleepFrom} onChange={(e) => touch(setSleepFrom)(e.target.value)}>
              <option value="">入れない</option>
              {times(18, 23).map((t) => <option key={t} value={t}>{t}</option>)}
              {times(0, 2).map((t) => <option key={`n${t}`} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="contact-field">
            <span>朝に起きた時刻</span>
            <select value={sleepTo} onChange={(e) => touch(setSleepTo)(e.target.value)}>
              <option value="">入れない</option>
              {times(4, 10).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>
      )}
      {items.includes('breakfast') && (
        <ChoiceGroup legend="朝ごはん" name="breakfast" value={breakfast} onChange={touch(setBreakfast)}
          options={(['1', '2', '3', '4'] as const).map((v) => [v, MEAL_AMOUNT_TEXT[v]] as const)} />
      )}
      {items.includes('mood') && moods.length > 0 && (
        <ChoiceGroup legend="きげん" name="mood" value={mood} onChange={touch(setMood)}
          options={moods.map((m) => [m, m] as const)} />
      )}
      {items.includes('pickup') && (
        <>
          <ChoiceGroup legend="お迎え" name="pickup" value={pickupType} onChange={touch(setPickupType)}
            options={[['1', 'いつもどおり'], ['2', '変更あり']] as const} />
          {pickupType === '2' && (
            <div className="contact-pickup">
              <ChoiceGroup legend="お迎えの人" name="pickup-person" value={pickupOther ? 'その他' : pickupPerson || null}
                onChange={(v) => { setDirty(true); if (v === 'その他') { setPickupOther(true); setPickupPerson(''); } else { setPickupOther(false); setPickupPerson(v); } }}
                options={[...PICKUP_PEOPLE, 'その他'].map((p) => [p, p] as const)} />
              {pickupOther && (
                <label className="contact-field">
                  <span>お迎えの人（{PICKUP_PERSON_MAX}文字まで）</span>
                  <input value={pickupPerson} maxLength={PICKUP_PERSON_MAX} onChange={(e) => touch(setPickupPerson)(e.target.value)} />
                </label>
              )}
              <label className="contact-field">
                <span>お迎えの時刻</span>
                <select value={pickupTime} onChange={(e) => touch(setPickupTime)(e.target.value)}>
                  <option value="">選ぶ</option>
                  {times(7, 20).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            </div>
          )}
        </>
      )}
      {items.includes('message') && (
        <label className="contact-field">
          <span>連絡事項（任意）</span>
          <textarea value={message} maxLength={MESSAGE_MAX} onChange={(e) => touch(setMessage)(e.target.value)} />
          <span className="muted contact-count">あと {MESSAGE_MAX - [...message].length} 文字</span>
        </label>
      )}
      {error && <p className="contact-error" role="alert">{error}</p>}
      <div className="contact-form-actions">
        <button type="submit" className="btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? TEXT.sending : !reachable ? TEXT.resend : '家庭からを送る'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}>やめる</button>}
      </div>
    </form>
  );
}
