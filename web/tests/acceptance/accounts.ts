/*
 * 受け入れテストで使うデモアカウント。
 *
 * アカウントの正は server/seed.sql（web/src/api/mockDb.ts も同じ中身）。
 * パスワードはここに書かず、seed.sql の目印（'!…'。サーバが起動のときに bcrypt へ置き換える。server/main.go の seedPasswords）
 * から読む。パスワードの文字をあちこちに増やさないため。シートの係も passwordOf() を使い、文字で書かない。
 *
 * 氏名・クラスは seed.sql のデモデータ（m_staff・m_guardian・t_class_staff・t_guardian_child）から写した。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_DIR } from './paths.mjs';

export type Entrance = 'staff' | 'guardian';

export interface DemoAccount {
  /** 何者か（テスト名や備考に出す呼び名） */
  label: string;
  /** ログインID */
  email: string;
  /** 開く入口。職員用と保護者用は同じ様式で、入口だけが異なる（図/画面詳細図「職員用トップ／保護者用トップ」(2-1)） */
  entrance: Entrance;
  role: 'admin' | 'staff' | 'guardian';
  /** 職員は職員名、保護者は保護者名 */
  name: string;
  /** 職員の担当クラス（2026年度）。管理者は持たない */
  className?: string;
  /** 保護者の、紐づけが有効な園児（氏名とクラス） */
  children?: { name: string; className: string }[];
}

export const ACCOUNTS = {
  /** 管理者（園長）。担当クラスなし */
  admin: { label: '管理者（西田）', email: 'nishida@hoiku.example.jp', entrance: 'staff', role: 'admin', name: '西田 拓也' },
  /** 管理者（予備）。自分の申請を承認できないことなど、管理者が2人要るケースに使う */
  admin2: { label: '管理者（遠藤）', email: 'endo@hoiku.example.jp', entrance: 'staff', role: 'admin', name: '遠藤 直人' },
  /** 一般（さくら組担任） */
  staffSakura: { label: '一般（さくら組・鈴木）', email: 'suzuki@hoiku.example.jp', entrance: 'staff', role: 'staff', name: '鈴木 浩之', className: 'さくら組' },
  /** 一般（さくら組担任）。一時パスワードのまま（変更するまで他の画面へ進めない） */
  staffTempPassword: { label: '一般（さくら組・村田・一時パスワード）', email: 'murata@hoiku.example.jp', entrance: 'staff', role: 'staff', name: '村田 真一', className: 'さくら組' },
  /** 一般（ひまわり組担任） */
  staffHimawari: { label: '一般（ひまわり組・久保田）', email: 'kubota@hoiku.example.jp', entrance: 'staff', role: 'staff', name: '久保田 和也', className: 'ひまわり組' },
  /** 保護者（西田 太郎の保護者） */
  guardian: { label: '保護者（西田 太郎）', email: 'nishida.t@example.jp', entrance: 'guardian', role: 'guardian', name: '西田 拓也', children: [{ name: '西田 太郎', className: 'さくら組' }] },
  /** 保護者（遠藤 花子の保護者）。規約の改定後、まだ再同意していない */
  guardianTermsStale: { label: '保護者（遠藤 花子・規約の再同意が要る）', email: 'endo.n@example.jp', entrance: 'guardian', role: 'guardian', name: '遠藤 直人', children: [{ name: '遠藤 花子', className: 'さくら組' }] },
  /** 保護者（鈴木 健の保護者だった）。紐づけが終わり、アカウントは停止中 */
  guardianSuspended: { label: '保護者（停止中）', email: 'suzuki.h@example.jp', entrance: 'guardian', role: 'guardian', name: '鈴木 浩之', children: [] },
  /** 保護者（村田 美咲の保護者） */
  guardianMurata: { label: '保護者（村田 美咲）', email: 'murata.s@example.jp', entrance: 'guardian', role: 'guardian', name: '村田 真一', children: [{ name: '村田 美咲', className: 'さくら組' }] },
  /** 保護者（久保田 陸の保護者） */
  guardianKubota: { label: '保護者（久保田 陸）', email: 'kubota.k@example.jp', entrance: 'guardian', role: 'guardian', name: '久保田 和也', children: [{ name: '久保田 陸', className: 'さくら組' }] },
} as const satisfies Record<string, DemoAccount>;

export type AccountKey = keyof typeof ACCOUNTS;

let seedPasswords: Map<string, string> | null = null;

/** seed.sql の m_account の行から、ログインIDとパスワードの目印を読む */
function loadSeedPasswords(): Map<string, string> {
  const sql = readFileSync(path.join(SERVER_DIR, 'seed.sql'), 'utf8');
  const map = new Map<string, string>();
  // 例: (1,'nishida@hoiku.example.jp','!pass1234','1',…
  for (const m of sql.matchAll(/\(\s*\d+\s*,\s*'([^']+@[^']+)'\s*,\s*'!([^']+)'/g)) map.set(m[1], m[2]);
  if (map.size === 0) throw new Error('[acceptance:harness] server/seed.sql からデモアカウントのパスワードを読めませんでした');
  return map;
}

/** デモアカウントのパスワード（server/seed.sql から読む） */
export function passwordOf(account: DemoAccount | AccountKey): string {
  const email = typeof account === 'string' ? ACCOUNTS[account].email : account.email;
  seedPasswords ??= loadSeedPasswords();
  const password = seedPasswords.get(email);
  if (password === undefined) throw new Error(`[acceptance:harness] server/seed.sql に ${email} のパスワードがありません`);
  return password;
}

export function accountOf(who: DemoAccount | AccountKey): DemoAccount {
  return typeof who === 'string' ? ACCOUNTS[who] : who;
}
