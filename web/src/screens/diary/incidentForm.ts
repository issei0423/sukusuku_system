/*
 * ヒヤリハットの欄の入力の形と、保存のときに送る形への変換
 * 典拠：図/画面詳細図.md「日誌作成・編集画面」(3-2) 項目18〜21・28、詳細設計書.md「日誌」(4-13 (1))
 * 部品は ./IncidentFields.tsx。検査はサーバとモックが行う（server/api_diary_incident.go）
 */
import type { DiaryIncidentInput } from '../../api/client';
import type { DiaryIncident } from '../../api/types';

export type NoticeMethod = '1' | '2' | '3' | '9';

/** 伝えた手段（基本設計書「日誌（t_diary）」(5-5) の guardian_notice_method。画面の言い方は画面詳細図 3-2 項目21） */
export const GUARDIAN_NOTICE_METHOD: Record<NoticeMethod, string> = {
  '1': '電話', '2': 'お迎えのときに対面', '3': '連絡帳や個人チャット', '9': 'その他',
};
export const NOTICE_METHODS: NoticeMethod[] = ['1', '2', '3', '9'];

/** 入力中のヒヤリハットの欄。日時は datetime-local の 'YYYY-MM-DDTHH:MM' */
export interface IncidentForm {
  occurredAt: string;
  place: string;
  situation: string;
  response: string;
  countermeasure: string;
  guardianNotice: '' | '1' | '2';
  noticedAt: string;
  noticeMethod: '' | NoticeMethod;
  noticePerson: string;
}

export const EMPTY_INCIDENT: IncidentForm = {
  occurredAt: '', place: '', situation: '', response: '', countermeasure: '',
  guardianNotice: '', noticedAt: '', noticeMethod: '', noticePerson: '',
};

/** 読んだ日誌のヒヤリハットの欄を、入力の形にする */
export function incidentFormOf(inc: DiaryIncident | null | undefined): IncidentForm {
  if (!inc) return EMPTY_INCIDENT;
  return {
    occurredAt: inc.occurred_at.slice(0, 16),
    place: inc.place,
    situation: inc.situation,
    response: inc.response,
    countermeasure: inc.countermeasure,
    guardianNotice: inc.guardian_notice ?? '',
    noticedAt: (inc.guardian_noticed_at ?? '').slice(0, 16),
    noticeMethod: inc.guardian_notice_method ?? '',
    noticePerson: inc.guardian_notice_person ?? '',
  };
}

// datetime-local の値（秒なし）に秒を足して、サーバの形（'YYYY-MM-DDTHH:MM:SS'）にする
const withSeconds = (v: string) => (v.length === 16 ? `${v}:00` : v);

/** 保存のときに送る形にする。「伝えた」でなければ日時・手段・相手を送らない */
export function incidentInputOf(f: IncidentForm): DiaryIncidentInput {
  const told = f.guardianNotice === '1';
  return {
    occurred_at: withSeconds(f.occurredAt),
    place: f.place,
    situation: f.situation,
    response: f.response,
    countermeasure: f.countermeasure,
    guardian_notice: f.guardianNotice,
    guardian_noticed_at: told ? withSeconds(f.noticedAt) : '',
    guardian_notice_method: told ? f.noticeMethod : '',
    guardian_notice_person: told ? f.noticePerson : '',
  };
}

/** 必須の欄が埋まっているか（確認へ進めるか）。字数や未来の日時は、保存のときにサーバ（モック）が確かめる */
export function incidentReady(f: IncidentForm): boolean {
  const filled = !!f.occurredAt && !!f.place.trim() && !!f.situation.trim() && !!f.response.trim();
  if (f.guardianNotice !== '1') return filled;
  return filled && !!f.noticedAt && !!f.noticeMethod && !!f.noticePerson.trim();
}
