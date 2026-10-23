/*
 * 画面の描画で例外が起きたときの受け皿
 *
 * 受け皿が無いと、1つの画面の例外で React が画面全体を外し、真っ白になる（メニューも消え、ほかの画面へ移れない）。
 * 共通レイアウトの本文（Outlet）を囲み、メニューを残したまま本文だけを知らせに差し替える。
 * 画面を移ると（呼び出し側で key に経路を渡す）作り直され、移った先の画面は普通に出る。
 * 例：画面だけを新しくして、Go サーバを古いまま動かしていると、午睡チェックの園児の行に「ねた・おきた」が無く、
 * 午睡チェック画面を開いたところで真っ白になっていた。
 * 【仮置き】知らせの文言と「読み込み直す」のボタンは設計が定めていない（web/仮置き値.md）
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Alert } from './ui';

type Props = { children: ReactNode };
type State = { failed: boolean };

export default class ScreenErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 原因を開発者ツールで追えるよう残す（画面には出さない）
    console.error('画面の描画に失敗しました', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card">
        <Alert>画面を表示できませんでした。読み込み直しても表示されないときは、管理者へ連絡してください。</Alert>
        <div className="row-end" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => window.location.reload()}>読み込み直す</button>
        </div>
      </section>
    );
  }
}
