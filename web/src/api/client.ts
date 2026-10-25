/*
 * 画面が使うデータ層の入口
 *
 * 実装は2つある。
 *   api/http.ts … Go サーバ（server/）へ問い合わせる。通常はこちら
 *   api/mock.ts … ブラウザ内の mockDb を読み書きする。サーバを立てずに動かすとき
 *
 * どちらを使うかは環境変数 VITE_API で決める。既定は http。
 * テスト（web/tests/）は vitest.config.ts で mock に固定している。
 * VITE_API が mock でないビルドでは、vite.config.ts が下の './mock' を noMock.ts へ向ける。
 * デモのパスワードやログインIDを、公開する成果物（dist/）へ入れないため。
 *
 * 画面は必ず本ファイル経由で読み込む。実装の切り替えを画面側に持ち込まないため。
 */
import * as http from './http';
import * as mock from './mock';

const useMock = import.meta.env.VITE_API === 'mock';

const impl = useMock ? mock : http;

export const api = impl.api;
export const childName = impl.childName;
export const staffName = impl.staffName;
export const className = impl.className;
export const accountName = impl.accountName;
export const settingNumber = impl.settingNumber;
export const settingText = impl.settingText;
export const canSeeChild = impl.canSeeChild;
export const visibleChildren = impl.visibleChildren;
export const selectableClasses = impl.selectableClasses;
export const childrenOfGuardian = impl.childrenOfGuardian;
export const findChild = impl.findChild;
export const findStaff = impl.findStaff;
export const findAccount = impl.findAccount;

/** 手続き（パスワードの変更・規約への同意）を終えるまで拒否されたことの知らせ。どちらの実装も同じものを使う */
export { onProcedureRequired } from './procedure';

/** ログイン中のセッションがサーバに切られたことの知らせ（停止・紐づけの解除など。GitHub Issue #159） */
export { onSessionEnded } from './procedure';
export { onAccountChanged } from './sessionAccount';

/**
 * 裏の読み直しとして要求を送る。職員の自動ログアウトの「操作」に数えさせない（GitHub Issue #210）。
 * http は印の見出しを付ける。モックは呼ばれたときに印の中かを見て、期限を延ばさない
 */
export { asAutomatic } from './automatic';

/**
 * 開いている画面への知らせにつなぐ（live.ts）。返す関数で切る。
 * http はサーバ（GET /api/events）へつなぎ、mock はブラウザの中で同じ知らせを出す相手を決める
 */
export const connectLive = impl.connectLive;

/** いまどちらの実装で動いているか。画面の注記に使う */
export const backend: 'http' | 'mock' = useMock ? 'mock' : 'http';

export type {
  LoginError, ChildInput, DiaryFilter, DiaryInput, DiaryAttachmentInput, DiaryIncidentInput, ChatRoomView, NapChildState, DevListRow, CsvRow,
} from './shapes';
