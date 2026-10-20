package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/option"
)

/*
本物の draftWriter（ai_claude.go）が送る形と、返った形の読み方（詳細設計書「呼び出しの作り」(8-7 (1))・「SDK について確かめたこと」(8-10)）。
外部へは呼ばない。送り先を手元の偽のサーバ（httptest）へ向け、SDK が組み立てた要求を読む。
*/

type fakeMessagesServer struct {
	mu     sync.Mutex
	bodies []map[string]any
	header http.Header
	status int
	reply  string
}

func (f *fakeMessagesServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	json.Unmarshal(raw, &body)
	f.mu.Lock()
	f.bodies = append(f.bodies, body)
	f.header = r.Header.Clone()
	status, reply := f.status, f.reply
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("request-id", "req_test")
	if status != 0 && status != 200 {
		w.WriteHeader(status)
		w.Write([]byte(`{"type":"error","error":{"type":"api_error","message":"x"}}`))
		return
	}
	w.Write([]byte(reply))
}

func newFakeClaude(t *testing.T) (*fakeMessagesServer, *claudeWriter) {
	t.Helper()
	f := &fakeMessagesServer{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, newClaudeWriter("sk-test-key", "", option.WithBaseURL(srv.URL))
}

func TestClaudeWriterRequestShape(t *testing.T) {
	f, w := newFakeClaude(t)
	// 先頭に考えた跡（thinking）が来ても、文の塊（text）だけを読む
	f.reply = `{"id":"msg_1","type":"message","role":"assistant","model":"claude-haiku-5-5","stop_reason":"end_turn",
		"content":[{"type":"thinking","thinking":"","signature":"s"},{"type":"text","text":"{\"draft\":\"ありがとうございました。\"}"}],
		"usage":{"input_tokens":1,"output_tokens":1}}`
	reply, err := w.Write(context.Background(), draftRequest{System: "指示", User: `{"年齢":"1歳"}`, Schema: aiSchemaFor(aiPurposeFacilityNote)})
	if err != nil || reply.Refused || reply.JSON != `{"draft":"ありがとうございました。"}` {
		t.Fatalf("返った形: %+v %v", reply, err)
	}
	body := f.bodies[0]
	if body["model"] != "claude-haiku-5-5" || body["max_tokens"] != float64(2048) {
		t.Errorf("モデル・上限: %v %v", body["model"], body["max_tokens"])
	}
	oc, _ := body["output_config"].(map[string]any)
	format, _ := oc["format"].(map[string]any)
	if oc["effort"] != "low" || format["type"] != "json_schema" || format["schema"] == nil {
		t.Errorf("output_config: %v", body["output_config"])
	}
	// temperature などのサンプリングの値・考えることの指定・prefill は送らない（Haiku 5.5 は 400）
	for _, k := range []string{"temperature", "top_p", "top_k", "thinking"} {
		if _, ok := body[k]; ok {
			t.Errorf("%s を送っている", k)
		}
	}
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["role"] != "user" {
		t.Errorf("messages: %v", body["messages"])
	}
	if f.header.Get("x-api-key") != "sk-test-key" || f.header.Get("anthropic-version") == "" {
		t.Errorf("ヘッダ: x-api-key あり=%v version=%q", f.header.Get("x-api-key") != "", f.header.Get("anthropic-version"))
	}
}

func TestClaudeWriterRefusalAndErrors(t *testing.T) {
	f, w := newFakeClaude(t)
	f.reply = `{"id":"msg_2","type":"message","role":"assistant","model":"claude-haiku-5-5","stop_reason":"refusal","content":[],"usage":{"input_tokens":1,"output_tokens":0}}`
	reply, err := w.Write(context.Background(), draftRequest{System: "s", User: "u", Schema: aiSchemaFor(aiPurposeRephrase)})
	if err != nil || !reply.Refused {
		t.Fatalf("拒否: %+v %v", reply, err)
	}

	// キーが無効（401）は再試行しない。状態コードと RequestID だけを持つ
	f.status = 401
	before := len(f.bodies)
	_, err = w.Write(context.Background(), draftRequest{System: "s", User: "u", Schema: aiSchemaFor(aiPurposeRephrase)})
	se, ok := err.(*aiStatusError)
	if !ok || se.StatusCode != 401 || se.RequestID != "req_test" || !se.keyRejected() || len(f.bodies)-before != 1 {
		t.Fatalf("401: %v（呼んだ回数 %d）", err, len(f.bodies)-before)
	}
	if strings.Contains(err.Error(), "sk-test-key") {
		t.Fatal("誤りの文にキーが入っている")
	}

	// 混雑（503）は1回だけ再試行する（option.WithMaxRetries(1)）
	f.status = 503
	before = len(f.bodies)
	_, err = w.Write(context.Background(), draftRequest{System: "s", User: "u", Schema: aiSchemaFor(aiPurposeRephrase)})
	if se, ok := err.(*aiStatusError); !ok || se.StatusCode != 503 || len(f.bodies)-before != 2 {
		t.Fatalf("503: %v（呼んだ回数 %d）", err, len(f.bodies)-before)
	}
}
