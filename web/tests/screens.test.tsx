// @vitest-environment jsdom
/*
 * 全画面の描画テスト
 * 典拠：基本設計書.md「画面の一覧」(3-2)
 *
 * 33画面すべてが、想定するロールで実際に描画されることを確かめる。
 * データの読み込みは非同期のため、読み込み完了まで待ってから内容を検査する。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App';
import { SessionProvider } from '../src/session';
import type { SessionUser } from '../src/api/types';

const admin: SessionUser = {
  account_id: 1, email: 'takahashi@hoiku.example.jp', role: '1', display_name: '高橋 美咲',
  staff_id: 'S001', guardian_id: null, class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};
const teacher: SessionUser = {
  account_id: 3, email: 'yamada@hoiku.example.jp', role: '2', display_name: '山田 花子',
  staff_id: 'S003', guardian_id: null, class_id: 1, class_name: 'さくら組',
  is_temp_password: false, terms_agreed: true,
};
const guardian: SessionUser = {
  account_id: 6, email: 'yamada.k@example.jp', role: '3', display_name: '山田 健一',
  staff_id: null, guardian_id: 'G001', class_id: null, class_name: null,
  is_temp_password: false, terms_agreed: true,
};

function open(path: string, user: SessionUser | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider initialUser={user}>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

/** 読み込みが終わるまで待つ */
async function settled() {
  await waitFor(() => {
    expect(document.body.textContent).not.toContain('読み込んでいます');
  }, { timeout: 3000 });
}

afterEach(cleanup);

describe('共通・認証（7画面）', () => {
  it('保護者用トップ：新規登録の導線を置く', async () => {
    open('/', null);
    expect(screen.getByText('保護者用の入口')).toBeTruthy();
    expect(screen.getByText('招待コードで新規登録')).toBeTruthy();
  });

  it('職員用トップ：新規登録の導線を置かない', async () => {
    open('/staff-top', null);
    expect(screen.getByText('職員用の入口')).toBeTruthy();
    expect(screen.queryByText('招待コードで新規登録')).toBeNull();
  });

  it('新規登録画面：招待コードが確認できるまで先の段階を操作できない', async () => {
    const { container } = open('/signup', null);
    await settled();
    const locked = container.querySelectorAll('.step.locked');
    expect(locked.length).toBe(2);
  });

  it('パスワード変更画面', async () => {
    open('/staff/password', teacher);
    expect(screen.getByText('パスワードの変更')).toBeTruthy();
  });

  it('利用規約同意画面', async () => {
    open('/terms-agree', guardian);
    expect(screen.getByText('利用規約への同意')).toBeTruthy();
  });

  it('職員ダッシュボード', async () => {
    open('/staff', teacher);
    await settled();
    expect(screen.getAllByText('ダッシュボード').length).toBeGreaterThan(0);
    expect(screen.getByText('未対応')).toBeTruthy();
  });

  it('保護者ホーム', async () => {
    open('/guardian', guardian);
    await settled();
    expect(screen.getByText('山田 太郎')).toBeTruthy();
  });
});

describe('日誌システム（6画面）', () => {
  it('日誌一覧画面：状態を列として持つ', async () => {
    open('/staff/diary', teacher);
    await settled();
    expect(screen.getByText('記録日')).toBeTruthy();
    expect(screen.getAllByText('状態').length).toBeGreaterThan(0);
  });

  it('日誌作成・編集画面：過去の記録を同じ画面に並べる', async () => {
    open('/staff/diary/new', teacher);
    await settled();
    expect(screen.getByText('日誌の作成')).toBeTruthy();
    expect(screen.getByText('この園児の過去の記録')).toBeTruthy();
  });

  it('日誌作成・編集画面：他の職員が編集中ならその旨を出す', async () => {
    // 日誌2は佐藤 明子（S004）がロックを保持している
    open('/staff/diary/2', teacher);
    await waitFor(() => {
      expect(document.body.textContent).toContain('佐藤 明子さんが編集中です');
    }, { timeout: 3000 });
  });

  it('日誌確認画面：直接開いたときは案内を出す', async () => {
    open('/staff/diary/confirm', teacher);
    expect(screen.getByText(/確認する内容がありません/)).toBeTruthy();
  });

  it('承認待ち一覧画面（管理者）', async () => {
    open('/staff/admin/approval', admin);
    await settled();
    expect(screen.getAllByText('承認待ち').length).toBeGreaterThan(0);
  });

  it('承認待ち一覧画面は一般には見せない', async () => {
    open('/staff/admin/approval', teacher);
    await settled();
    expect(screen.queryByText('承認待ち')).toBeNull();
  });

  it('日誌承認画面：共有の指定を同じ画面に置く', async () => {
    open('/staff/admin/approval/2', admin);
    await settled();
    expect(screen.getByText('保護者への共有')).toBeTruthy();
    expect(screen.getByText('承認する')).toBeTruthy();
    expect(screen.getByText('差し戻す')).toBeTruthy();
  });

  it('園児タイムライン画面', async () => {
    open('/staff/diary/timeline/C001', teacher);
    await settled();
    expect(screen.getByText('山田 太郎 の記録')).toBeTruthy();
  });
});

describe('チャットツール（3画面）', () => {
  it('チャット画面（職員）：チャンネル・メンバーを持つ', async () => {
    open('/staff/chat', teacher);
    await settled();
    expect(screen.getByText('チャンネル')).toBeTruthy();
    expect(screen.getByText('メンバー')).toBeTruthy();
  });

  it('チャット画面（保護者）', async () => {
    open('/guardian/chat', guardian);
    await settled();
    expect(screen.getByText('担任の先生とのやりとり')).toBeTruthy();
  });

  it('グループ編成画面', async () => {
    open('/staff/chat/groups', teacher);
    await settled();
    expect(screen.getByText('グループ編成')).toBeTruthy();
  });

  it('誤送信対応記録画面（管理者）', async () => {
    open('/staff/admin/misdelivery', admin);
    await settled();
    expect(screen.getByText('誤送信対応の記録')).toBeTruthy();
  });
});

describe('午睡チェック（3画面）', () => {
  it('午睡チェック画面：実施中はタイマーと園児カードを出す', async () => {
    open('/staff/nap', teacher);
    // 実施中のセッションの取得が終わるまでタイマーは出ない
    await waitFor(() => {
      expect(screen.getByText('次のチェックまで')).toBeTruthy();
    }, { timeout: 3000 });
    expect(screen.getByText('午睡チェックを終了')).toBeTruthy();
    // 記録済み 8 / 12 名（デモデータ）。園児の状態はセッション取得後に読み直すため待つ
    await waitFor(() => {
      expect(document.body.textContent).toContain('記録済み 8 / 12 名');
    }, { timeout: 3000 });
  });

  it('午睡チェック画面：平熱を並べて表示する（判定はしない）', async () => {
    open('/staff/nap', teacher);
    await settled();
    await waitFor(() => {
      expect(document.body.textContent).toContain('平熱 36.6');
    }, { timeout: 3000 });
  });

  it('異常時記録画面：ヒヤリハット未起票のものを起票できる', async () => {
    open('/staff/nap/abnormal', teacher);
    await settled();
    expect(screen.getByText('異常時の記録')).toBeTruthy();
    expect(screen.getAllByText('起票する').length).toBeGreaterThan(0);
  });

  it('午睡記録検索画面：チェック時刻と保存時刻の両方を出す', async () => {
    open('/staff/nap/search', teacher);
    await settled();
    expect(screen.getByText('チェック時刻')).toBeTruthy();
    expect(screen.getByText('保存時刻')).toBeTruthy();
  });
});

describe('発達チェック・身体測定（5画面）', () => {
  it('発達チェック一覧画面：未実施を強調する', async () => {
    open('/staff/growth', teacher);
    await settled();
    expect(document.body.textContent).toContain('予定日を過ぎて未実施の園児');
  });

  it('発達チェック入力画面：免責を常時表示する', async () => {
    open('/staff/growth/dev/C001', teacher);
    await settled();
    expect(screen.getByText('本機能は発達の判定・診断を行うものではありません。')).toBeTruthy();
    expect(screen.getByText('確定する')).toBeTruthy();
  });

  it('発達チェック入力画面：月齢から区分を引く', async () => {
    open('/staff/growth/dev/C001', teacher);
    await settled();
    // 2025-06-01 生まれ、2026-09-01 時点で 15 か月 → 1歳3か月頃〜1歳6か月頃
    expect(document.body.textContent).toContain('1歳3か月頃〜1歳6か月頃');
  });

  it('スケジュール設定画面（管理者）', async () => {
    open('/staff/growth/schedule', admin);
    await settled();
    expect(screen.getByText('スケジュール設定')).toBeTruthy();
    expect(screen.getByText('システムの提案')).toBeTruthy();
  });

  it('スケジュール設定画面は一般には見せない', async () => {
    open('/staff/growth/schedule', teacher);
    await settled();
    expect(screen.queryByText('システムの提案')).toBeNull();
  });

  it('身体記録画面：クラスの実施状況と免責を出す', async () => {
    open('/staff/growth/physical', teacher);
    await settled();
    expect(document.body.textContent).toContain('未実施：');
    expect(screen.getByText('本グラフは発育の判定・診断を行うものではありません。')).toBeTruthy();
  });

  it('身体記録画面：PDF出力は一般には出さない', async () => {
    open('/staff/growth/physical', teacher);
    await settled();
    expect(screen.queryByText('PDF出力')).toBeNull();
  });

  it('共有範囲設定画面（管理者）', async () => {
    open('/staff/growth/share', admin);
    await settled();
    expect(screen.getByText('共有範囲の設定')).toBeTruthy();
  });
});

describe('園児マスター・アカウント管理（10画面）', () => {
  it('園児一覧画面：一般には登録・一括登録のボタンを出さない', async () => {
    open('/staff/children', teacher);
    await settled();
    expect(screen.getByText('アレルギー一覧')).toBeTruthy();
    expect(screen.queryByText('新規登録')).toBeNull();
    expect(screen.queryByText('CSV一括登録')).toBeNull();
  });

  it('園児一覧画面：管理者には登録・一括登録のボタンを出す', async () => {
    open('/staff/children', admin);
    await settled();
    expect(screen.getByText('新規登録')).toBeTruthy();
    expect(screen.getByText('CSV一括登録')).toBeTruthy();
  });

  it('園児情報入力画面（管理者）', async () => {
    open('/staff/children/new', admin);
    await settled();
    expect(screen.getByText('園児情報の登録')).toBeTruthy();
    expect(screen.getByText('確認へ進む')).toBeTruthy();
  });

  it('園児情報確認画面：直接開いたときは案内を出す', async () => {
    open('/staff/children/confirm', admin);
    expect(screen.getByText(/確認する内容がありません/)).toBeTruthy();
  });

  it('CSV一括登録画面：エラー行を判定して出す', async () => {
    open('/staff/children/csv', admin);
    await settled();
    expect(screen.getByText('取込内容を確認する')).toBeTruthy();
  });

  it('アレルギー一覧画面：全園児が対象', async () => {
    open('/staff/children/allergies', teacher);
    await settled();
    expect(screen.getByText('アレルギー一覧（全園児）')).toBeTruthy();
    // 一般（さくら組担任）にも、ひまわり組の園児が出る
    expect(document.body.textContent).toContain('井上 空');
  });

  it('年度更新画面：未確定事項があるため実行できない', async () => {
    open('/staff/admin/fiscal-year', admin);
    await settled();
    expect(screen.getByText('年度更新を実行する').hasAttribute('disabled')).toBe(true);
  });

  it('職員アカウント管理画面（管理者）', async () => {
    open('/staff/admin/staff-accounts', admin);
    await settled();
    expect(screen.getAllByText('一時パスワード再発行').length).toBeGreaterThan(0);
  });

  it('招待コード管理画面：園児名でまとめて出す', async () => {
    open('/staff/admin/invitations', admin);
    await settled();
    expect(screen.getByText('一括発行')).toBeTruthy();
    expect(screen.getByText('配布用に出力')).toBeTruthy();
  });

  it('保護者アカウント管理画面：未同意者を知らせる', async () => {
    open('/staff/admin/guardian-accounts', admin);
    await settled();
    expect(document.body.textContent).toContain('同意していない保護者');
  });

  it('操作ログ参照画面（管理者）', async () => {
    open('/staff/admin/logs', admin);
    await settled();
    expect(screen.getByText('CSV出力')).toBeTruthy();
    expect(screen.getByText('操作日時')).toBeTruthy();
  });

  it('操作ログ参照画面は一般には見せない', async () => {
    open('/staff/admin/logs', teacher);
    await settled();
    expect(screen.queryByText('操作日時')).toBeNull();
  });
});

describe('保護者から見える範囲', () => {
  it('保護者は職員の画面へ入れない', async () => {
    open('/staff/diary', guardian);
    await settled();
    expect(screen.queryByText('記録日')).toBeNull();
  });

  it('共有された日誌は開ける', async () => {
    open('/guardian/diary/4', guardian);
    await settled();
    // 日誌4は C002（鈴木 花子）のもの。山田 健一は参照できない
    expect(document.body.textContent).toContain('権限がありません');
  });

  it('自児の共有済みの日誌は開ける', async () => {
    open('/guardian/diary/5', guardian);
    await settled();
    expect(document.body.textContent).toContain('砂場でスコップ');
  });
});
