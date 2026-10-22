/*
 * ヒヤリハットの欄（日誌作成・編集画面・日誌確認画面・日誌承認画面）
 * 典拠：図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目18〜21・28、「日誌承認画面（管理者）」(3-5) 項目3、
 *      詳細設計書.md「日誌の画面（作り直し）」(2-13 (8))、基本設計書.md「ヒヤリハットの記録」(4-6)
 *
 * 記録種別をヒヤリハットにすると、本文の代わりに発生日時・場所・状況・とった対応・保護者へ伝えたこと・今後の対策を出す。
 * 今後の対策は項目21の下に置く。人が書く欄であり、システムは原因の判定・過失の評価をしない。
 * 保護者へは共有しない（伝えたことを職員が書き残す）。検査はサーバとモックが行う（server/api_diary_incident.go）
 */
import type { DiaryIncidentInput } from '../../api/client';
import type { DiaryIncident } from '../../api/types';
import { Field, Radios } from '../../components/ui';
import { formatYMD, now } from '../../api/util';
import { GUARDIAN_NOTICE_METHOD, NOTICE_METHODS } from './incidentForm';
import type { IncidentForm, NoticeMethod } from './incidentForm';

// 欄の上限（基本設計書「入力項目の制約値」(4-12)）
const PLACE_MAX = 100;
const TEXT_MAX = 1000;
const PERSON_MAX = 50;

const rest = (v: string, max: number) => <div className="muted" aria-live="polite">残り {max - [...v].length} 文字</div>;

/** 入力の欄（日誌作成・編集画面の項目18〜21・28） */
export function IncidentFields({ value, onChange, disabled }: {
  value: IncidentForm; onChange: (next: IncidentForm) => void; disabled?: boolean;
}) {
  const set = <K extends keyof IncidentForm>(key: K, v: IncidentForm[K]) => onChange({ ...value, [key]: v });
  // 未来の日時は選ばせない（5分刻み）。打ち込んだ値はサーバ（モック）が断る
  const maxDateTime = now().slice(0, 16);
  return (
    <>
      <div className="row">
        <Field label="発生日時" required>
          <input type="datetime-local" step={300} max={maxDateTime} value={value.occurredAt} disabled={disabled}
            onChange={(e) => set('occurredAt', e.target.value)} />
        </Field>
        <Field label="場所" required style={{ flex: 1 }}>
          <input type="text" value={value.place} maxLength={PLACE_MAX} disabled={disabled}
            onChange={(e) => set('place', e.target.value)} />
        </Field>
      </div>
      <Field label="状況" required>
        <textarea value={value.situation} maxLength={TEXT_MAX} disabled={disabled} style={{ minHeight: 120 }}
          onChange={(e) => set('situation', e.target.value)} />
      </Field>
      {!disabled && rest(value.situation, TEXT_MAX)}
      <Field label="とった対応" required>
        <textarea value={value.response} maxLength={TEXT_MAX} disabled={disabled} style={{ minHeight: 120 }}
          onChange={(e) => set('response', e.target.value)} />
      </Field>
      {!disabled && rest(value.response, TEXT_MAX)}
      <Field label="保護者へ伝えたこと">
        <Radios name="guardianNotice" value={value.guardianNotice || null} disabled={disabled}
          options={[{ value: '1' as const, label: '伝えた' }, { value: '2' as const, label: '伝えていない' }]}
          onChange={(v) => set('guardianNotice', v)} />
      </Field>
      {value.guardianNotice === '1' && (
        <div className="row">
          <Field label="伝えた日時" required>
            <input type="datetime-local" step={300} max={maxDateTime} value={value.noticedAt} disabled={disabled}
              onChange={(e) => set('noticedAt', e.target.value)} />
          </Field>
          <Field label="伝えた手段" required>
            <select value={value.noticeMethod} disabled={disabled}
              onChange={(e) => set('noticeMethod', e.target.value as IncidentForm['noticeMethod'])}>
              <option value="">選んでください</option>
              {NOTICE_METHODS.map((k) => (
                <option key={k} value={k}>{GUARDIAN_NOTICE_METHOD[k]}</option>
              ))}
            </select>
          </Field>
          <Field label="伝えた相手" required style={{ flex: 1 }}>
            <input type="text" value={value.noticePerson} maxLength={PERSON_MAX} disabled={disabled}
              onChange={(e) => set('noticePerson', e.target.value)} />
          </Field>
        </div>
      )}
      <Field label="今後の対策">
        <textarea value={value.countermeasure} maxLength={TEXT_MAX} disabled={disabled} style={{ minHeight: 100 }}
          onChange={(e) => set('countermeasure', e.target.value)} />
      </Field>
      {!disabled && rest(value.countermeasure, TEXT_MAX)}
    </>
  );
}

// 'YYYY-MM-DDTHH:MM(:SS)' を '2026/09/01（火） 13:40' の形にする
const formatDateTime = (v: string | null | undefined) => (v ? `${formatYMD(v.slice(0, 10))} ${v.slice(11, 16)}` : '―');

/** 読み取り専用の表示（日誌確認画面の項目3、日誌承認画面の項目3） */
export function IncidentSummary({ incident }: { incident: DiaryIncident | DiaryIncidentInput }) {
  const told = incident.guardian_notice === '1';
  const method = (incident.guardian_notice_method || null) as NoticeMethod | null;
  const pre = { whiteSpace: 'pre-wrap' } as const;
  return (
    <table className="list">
      <tbody>
        <tr><th scope="row" style={{ width: 140 }}>発生日時</th><td>{formatDateTime(incident.occurred_at)}</td></tr>
        <tr><th scope="row">場所</th><td>{incident.place || '―'}</td></tr>
        <tr><th scope="row">状況</th><td style={pre}>{incident.situation}</td></tr>
        <tr><th scope="row">とった対応</th><td style={pre}>{incident.response}</td></tr>
        <tr>
          <th scope="row">保護者へ伝えたこと</th>
          <td>
            {told ? `伝えた（${formatDateTime(incident.guardian_noticed_at)}・${method ? GUARDIAN_NOTICE_METHOD[method] : ''}・${incident.guardian_notice_person ?? ''}）`
              : incident.guardian_notice === '2' ? '伝えていない' : '―'}
          </td>
        </tr>
        <tr><th scope="row">今後の対策</th><td style={pre}>{incident.countermeasure || '―'}</td></tr>
      </tbody>
    </table>
  );
}
