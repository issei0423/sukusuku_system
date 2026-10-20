package main

import (
	"context"
	"errors"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

/*
本物の draftWriter（詳細設計書「呼び出しの作り（差し替えられる形）」(8-7 (1))・「SDK について確かめたこと」(8-10)）。
公式の Go SDK（github.com/anthropics/anthropic-sdk-go）で Claude Haiku を呼ぶ。

| 設定 | 値 |
| モデル | claude-haiku-5-5（文字列で渡す。起動の -ai-model か環境変数 SUKUSUKU_AI_MODEL で変えられる。main.go） |
| MaxTokens | 2048（Haiku 5.5 は考える分も max_tokens に数える） |
| 考える深さ | OutputConfig.Effort を low（anthropic.OutputConfigEffortLow。Haiku 5.5 の既定は medium） |
| 考えること | 指定しない（Haiku 5.5 は既定で adaptive） |
| temperature など | 渡さない（Haiku 5.5 は既定以外の値で 400） |
| prefill | 使わない（Haiku 5.5 は 400） |
| 出力の形 | OutputConfig.Format に anthropic.JSONOutputFormatParam{Schema: …}（type は json_schema が既定で入る） |
| 再試行 | option.WithMaxRetries(1)（SDK の既定は 2。408・409・429・5xx と接続の失敗を再試行する） |
| 時間の上限 | 呼ぶ側（api_ai.go）が context.WithTimeout を再試行を含めた全体にかける（決めたこと D-10） |

キーは option.WithAPIKey で渡すだけで、このファイルの外へ出さない。ログにも出さない。
*/

// defaultAiModel は、使うモデル（基本設計書「文章の下書き（AI）」(4-11)）
const defaultAiModel = "claude-haiku-5-5"

// aiMaxTokens は、考える分を含めた出力の上限（詳細設計書 (8-7 (1))。演習上の想定 2048）
const aiMaxTokens = 2048

type claudeWriter struct {
	client anthropic.Client
	model  string
}

// newClaudeWriter は、キーとモデルを持った本物の口を作る。opts はテストで送り先を偽のサーバへ向けるときに使う
func newClaudeWriter(key, model string, opts ...option.RequestOption) *claudeWriter {
	if model == "" {
		model = defaultAiModel
	}
	base := []option.RequestOption{option.WithAPIKey(key), option.WithMaxRetries(1)}
	return &claudeWriter{client: anthropic.NewClient(append(base, opts...)...), model: model}
}

func (w *claudeWriter) Write(ctx context.Context, req draftRequest) (draftReply, error) {
	msg, err := w.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(w.model),
		MaxTokens: aiMaxTokens,
		System:    []anthropic.TextBlockParam{{Text: req.System}},
		Messages:  []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(req.User))},
		OutputConfig: anthropic.OutputConfigParam{
			Effort: anthropic.OutputConfigEffortLow,
			Format: anthropic.JSONOutputFormatParam{Schema: req.Schema},
		},
	})
	if err != nil {
		// 2xx 以外はどれも *anthropic.Error。状態コードと RequestID だけを取り出す（本文は持ち出さない）
		var apierr *anthropic.Error
		if errors.As(err, &apierr) {
			return draftReply{}, &aiStatusError{StatusCode: apierr.StatusCode, RequestID: apierr.RequestID}
		}
		return draftReply{}, err
	}
	if msg.StopReason == anthropic.StopReasonRefusal {
		return draftReply{Refused: true}, nil
	}
	// 先頭に考えた跡（ThinkingBlock）が来ることがあるため、位置で読まずに種類で読む
	var b strings.Builder
	for _, block := range msg.Content {
		if t, ok := block.AsAny().(anthropic.TextBlock); ok {
			b.WriteString(t.Text)
		}
	}
	return draftReply{JSON: b.String()}, nil
}
