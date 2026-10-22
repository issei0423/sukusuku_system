/*
 * 自動ログアウトの期限を返す・延ばす規則（モック。GitHub Issue #210）
 * 典拠：基本設計書.md「ログイン」(4-3)「自動ログアウトは職員の画面に限り、最後の操作から時間を数える。
 *      午睡チェックの実施中は対象外」、WCAG 2.2 達成基準 2.2.1 タイミング調整可能（レベル A）
 *
 * サーバ（server/api_session.go、server/api_session_test.go）と同じ規則をモック（api/mock.ts の sessionStatus・
 * extendSession）でも確かめる。期限を尋ねても延びない。操作（印の無い要求）と「続ける」で延びる。裏の読み直し（asAutomatic）は
 * 延ばさない。午睡チェックの実施中は期限を返さない。保護者には期限を返さない。
 *
 * 時計は tests/setup-clock.ts が止めている（偽物は Date だけ）。vi.setSystemTime で時刻を動かす。
 * モックの応答（setTimeout）は本物の時計で動く。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { api, asAutomatic, onSessionEnded } from '../src/api/client';
import * as db from '../src/api/mockDb';
import { today } from '../src/api/util';
import type { SessionUser } from '../src/api/types';

const teacher: SessionUser = {
  account_id: 3, email: 'takanashi@hoiku.example.jp', role: '2', display_name: '高梨 倫太朗',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'nohara.i@example.jp', role: '3', display_name: '野原 一誠',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

/** 今日のその時刻（JST）に時計を置く */
function setClock(hm: string, sec = 0): void {
  vi.setSystemTime(new Date(`${today()}T${hm}:${String(sec).padStart(2, '0')}+09:00`));
}

// 読み込んだときの時刻（setup-clock.ts が止めた 18:00）。ほかのテストファイルに時刻を持ち越さないよう、戻す
const loadedAt = new Date();
afterEach(() => {
  vi.setSystemTime(loadedAt);
});

describe('職員の期限（最後の操作から数える）', () => {
  it('期限はログインから30分。尋ねても延びず、操作で延び、裏の読み直しでは延びない', async () => {
    setClock('18:00');
    await api.login(teacher.email, 'pass1234', 'staff');
    expect(await api.sessionStatus(teacher)).toEqual({
      auto_logout: true, nap_exempt: false, expires_at: `${today()}T18:30:00`, remaining_seconds: 1800,
    });

    // 尋ねても延びない
    setClock('18:10');
    expect(await api.sessionStatus(teacher)).toMatchObject({ expires_at: `${today()}T18:30:00`, remaining_seconds: 1200 });

    // 同じブラウザのほかのタブで操作した（モックではセッションをアカウントで見る）。延びた期限が返る
    await api.listChildren(teacher);
    expect(await api.sessionStatus(teacher)).toMatchObject({ expires_at: `${today()}T18:40:00`, remaining_seconds: 1800 });

    // 裏の読み直しは延ばさない
    setClock('18:20');
    await asAutomatic(() => api.staffSummary(teacher));
    expect(await api.sessionStatus(teacher)).toMatchObject({ expires_at: `${today()}T18:40:00`, remaining_seconds: 1200 });
  });

  it('「続ける」で押した時刻から30分に延びる', async () => {
    setClock('18:00');
    await api.login(teacher.email, 'pass1234', 'staff');
    setClock('18:28');
    expect(await api.extendSession(teacher)).toEqual({
      auto_logout: true, nap_exempt: false, expires_at: `${today()}T18:58:00`, remaining_seconds: 1800,
    });
  });

  it('30分ちょうどまでは使え、過ぎたら尋ねても続けても切れたと知らせる。ログインし直せば戻る', async () => {
    setClock('18:00');
    await api.login(teacher.email, 'pass1234', 'staff');
    setClock('18:30');
    expect(await api.sessionStatus(teacher)).toMatchObject({ remaining_seconds: 0 });

    let ended = 0;
    const stop = onSessionEnded(() => { ended += 1; });
    try {
      setClock('18:30', 1);
      await expect(api.sessionStatus(teacher)).rejects.toThrow('ログインしていません');
      // 切れたあとは、操作しても「続ける」を押しても戻らない
      await api.listChildren(teacher);
      await expect(api.extendSession(teacher)).rejects.toThrow('ログインしていません');
      expect(ended).toBe(2);
    } finally {
      stop();
    }

    await api.login(teacher.email, 'pass1234', 'staff');
    expect(await api.sessionStatus(teacher)).toMatchObject({ remaining_seconds: 1800 });
  });
});

describe('午睡チェックの実施中と保護者', () => {
  it('開始した午睡チェックの実施中は期限を返さず、時間帯の終わりから数え直す', async () => {
    // 高梨（S003）が今日の 13:05 にさくら組の午睡チェックを開始し、終えていない。
    // デモデータの実施は、ほかのテストの読み直しで自動の解除が済んでいることがあるので、ここで足す
    const nap = {
      nap_session_id: 90_001, class_id: 1, session_date: today(), started_staff_id: 'S003',
      started_at: `${today()}T13:05:00`, ended_staff_id: null, ended_at: null, is_auto_closed: false,
    };
    db.napSessions.push(nap);
    try {
      setClock('13:30');
      await api.login(teacher.email, 'pass1234', 'staff');
      expect(await api.sessionStatus(teacher)).toEqual({
        auto_logout: true, nap_exempt: true, expires_at: null, remaining_seconds: null,
      });

      // 終了の操作を忘れたまま、午睡の時間帯（13:00-15:00）が終わった。15:00 から30分
      setClock('15:10');
      expect(await api.sessionStatus(teacher)).toEqual({
        auto_logout: true, nap_exempt: false, expires_at: `${today()}T15:30:00`, remaining_seconds: 1200,
      });
    } finally {
      db.napSessions.splice(db.napSessions.indexOf(nap), 1);
    }
  });

  it('保護者には自動ログアウトが無いので、期限を返さない', async () => {
    setClock('18:00');
    await api.login(guardian.email, 'pass1234', 'guardian');
    setClock('23:00');
    expect(await api.sessionStatus(guardian)).toEqual({
      auto_logout: false, nap_exempt: false, expires_at: null, remaining_seconds: null,
    });
  });
});
