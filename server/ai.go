package main

import (
	"context"
	"fmt"
	"time"
)

/*
外部の AI を呼ぶ口（詳細設計書「呼び出しの作り（差し替えられる形）」(8-7 (1))、基本設計書「呼び出し方」(4-11)）。

呼ぶのはバックエンドだけ。app.ai が nil のとき（起動したときに環境変数 ANTHROPIC_API_KEY が無かった）は AI を使わない。
本物は ai_claude.go の claudeWriter（公式の Go SDK）。テストは ai_test.go の fakeWriter に差し替え、外部へは呼ばない（8-11）。
*/

// draftWriter は外部の AI を呼ぶ口。テストでは偽物に差し替える
type draftWriter interface {
	Write(ctx context.Context, req draftRequest) (draftReply, error)
}

// draftRequest は、置き換え済みの送る中身（8-6）
type draftRequest struct {
	System string         // 指示の文（ai_prompt.go）
	User   string         // 渡す中身（JSON の文字列）。置き換え済み
	Schema map[string]any // 出力の形（構造化出力の JSON スキーマ）
}

// draftReply は、返った中身
type draftReply struct {
	JSON    string // 返った JSON の文字列（文の塊をつないだもの）
	Refused bool   // stop_reason が refusal
}

/*
aiStatusError は、提供者が 2xx 以外を返したこと（8-7 (2)）。
状態コードと RequestID だけを持ち、送った文・返った文は持たない（どのログにも出さないため。基本設計書「外部の AI へ送る情報」(6-3)）
*/
type aiStatusError struct {
	StatusCode int
	RequestID  string
}

func (e *aiStatusError) Error() string {
	return fmt.Sprintf("AI の提供者が %d を返しました（RequestID: %s）", e.StatusCode, e.RequestID)
}

// keyRejected は、キーが無効と分かったか（401・403。8-7 (2)）
func (e *aiStatusError) keyRejected() bool {
	return e.StatusCode == 401 || e.StatusCode == 403
}

// aiTimeout は、再試行を含めた全体の時間の上限（詳細設計書「呼び出し・上限・失敗のとき」(8-7 (1))、決めたこと D-10）
const aiTimeout = 10 * time.Second

// aiTimeoutOf は、この app の上限。テストでは短くする（返さずに待つ偽物で時間切れを確かめるため）
func (a *app) aiTimeoutOf() time.Duration {
	if a.aiTimeoutForTest > 0 {
		return a.aiTimeoutForTest
	}
	return aiTimeout
}
