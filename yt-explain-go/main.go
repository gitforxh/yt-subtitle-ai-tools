package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Port        string
	BaseURL     string
	SessionKey  string
	OpenClawBin string
}

type OpenClawMessage struct {
	Role      string `json:"role"`
	Text      string `json:"text"`
	Content   any    `json:"content"`
	Timestamp int64  `json:"timestamp"`
}

type OpenClawHistoryResp struct {
	Messages []OpenClawMessage `json:"messages"`
}

type inflightRequest struct {
	cancel     context.CancelFunc
	sessionKey string
}

type requestTracker struct {
	mu sync.Mutex
	m  map[string]inflightRequest
}

func (t *requestTracker) set(id string, r inflightRequest) {
	if strings.TrimSpace(id) == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m == nil {
		t.m = map[string]inflightRequest{}
	}
	t.m[id] = r
}

func (t *requestTracker) take(id string) (inflightRequest, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m == nil {
		return inflightRequest{}, false
	}
	r, ok := t.m[id]
	if ok {
		delete(t.m, id)
	}
	return r, ok
}

func (t *requestTracker) del(id string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.m == nil {
		return
	}
	delete(t.m, id)
}

func getenv(k, d string) string {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return d
	}
	return v
}

func loadConfig() Config {
	return Config{
		Port:        getenv("PORT", "18794"),
		BaseURL:     getenv("BASE_URL", "http://127.0.0.1:18794"),
		SessionKey:  getenv("SESSION_KEY", "ext-transcript"),
		OpenClawBin: getenv("OPENCLAW_BIN", "/opt/homebrew/bin/openclaw"),
	}
}

func runOpenClaw(ctx context.Context, openclawBin, method string, params map[string]any, out any) error {
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, openclawBin, "gateway", "call", method, "--params", string(paramsJSON))
	cmd.Dir = "/Users/xhuang/work/openclaw/workspace"
	cmd.Env = append(os.Environ(), "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = err.Error()
		}
		return fmt.Errorf(errText)
	}

	raw := strings.TrimSpace(stdout.String())
	// Some openclaw versions print a human line before JSON, e.g.:
	// "Gateway call: chat.send ..." then JSON on next line.
	if err := json.Unmarshal([]byte(raw), out); err == nil {
		return nil
	}

	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start >= 0 && end > start {
		candidate := raw[start : end+1]
		if err := json.Unmarshal([]byte(candidate), out); err == nil {
			return nil
		}
	}

	prefix := raw
	if len(prefix) > 240 {
		prefix = prefix[:240]
	}
	return fmt.Errorf("invalid JSON from openclaw: %s", prefix)
}

func textFromMessage(m OpenClawMessage) string {
	if strings.TrimSpace(m.Text) != "" {
		return strings.TrimSpace(m.Text)
	}
	switch c := m.Content.(type) {
	case string:
		return strings.TrimSpace(c)
	case []any:
		parts := make([]string, 0, len(c))
		for _, it := range c {
			obj, ok := it.(map[string]any)
			if !ok {
				continue
			}
			if t, ok := obj["text"].(string); ok && strings.TrimSpace(t) != "" {
				parts = append(parts, strings.TrimSpace(t))
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n"))
	default:
		return ""
	}
}

func explainViaOpenClaw(ctx context.Context, openclawBin, selectedText, sessionKey, userLanguage, requestID string) ([]any, error) {
	if strings.TrimSpace(requestID) == "" {
		requestID = fmt.Sprintf("RID-%d-%d", time.Now().UnixMilli(), time.Now().UnixNano()%1000000)
	}
	lang := strings.TrimSpace(userLanguage)
	if lang == "" {
		lang = "en"
	}
	prompt := fmt.Sprintf(
		"Task: Explain ONLY the selected text between <text> tags. Treat this as a standalone request and do not rely on any previous conversation context. Provide both word-by-word breakdown and grammar notes. IMPORTANT: Write meaning/explanation/example in user's language (%s). Return JSON only with shape: {\"requestId\":\"%s\",\"items\":[{\"word\":\"...\",\"reading\":\"...\",\"partOfSpeech\":\"...\",\"meaning\":\"...\"}],\"grammar\":[{\"pattern\":\"...\",\"explanation\":\"...\",\"example\":\"...\"}]}. The requestId must exactly match the given requestId.\n\n<text>%s</text>",
		lang,
		requestID,
		selectedText,
	)

	var sendResp map[string]any
	err := runOpenClaw(ctx, openclawBin, "chat.send", map[string]any{
		"sessionKey":     sessionKey,
		"message":        prompt,
		"deliver":        false,
		"idempotencyKey": requestID,
	}, &sendResp)
	if err != nil {
		return nil, err
	}

	for i := 0; i < 12; i++ {
		time.Sleep(1200 * time.Millisecond)
		var hist OpenClawHistoryResp
		err := runOpenClaw(ctx, openclawBin, "chat.history", map[string]any{
			"sessionKey": sessionKey,
			"limit":      8,
		}, &hist)
		if err != nil {
			continue
		}

		for j := len(hist.Messages) - 1; j >= 0; j-- {
			m := hist.Messages[j]
			if strings.ToLower(strings.TrimSpace(m.Role)) != "assistant" {
				continue
			}
			text := textFromMessage(m)
			if text == "" {
				continue
			}
			var parsed map[string]any
			if json.Unmarshal([]byte(text), &parsed) != nil {
				start := strings.Index(text, "{")
				end := strings.LastIndex(text, "}")
				if start >= 0 && end > start {
					_ = json.Unmarshal([]byte(text[start:end+1]), &parsed)
				}
			}
			rid, ok := parsed["requestId"].(string)
			if !ok || strings.TrimSpace(rid) != strings.TrimSpace(requestID) {
				continue
			}
			if items, ok := parsed["items"].([]any); ok {
				if grammar, gok := parsed["grammar"].([]any); gok && len(grammar) > 0 {
					items = append(items, map[string]any{"word": "— Grammar —", "reading": "", "partOfSpeech": "", "meaning": ""})
					for _, g := range grammar {
						gm, _ := g.(map[string]any)
						pattern, _ := gm["pattern"].(string)
						explanation, _ := gm["explanation"].(string)
						example, _ := gm["example"].(string)
						items = append(items, map[string]any{
							"word":         pattern,
							"reading":      "grammar",
							"partOfSpeech": "pattern",
							"meaning": strings.TrimSpace(explanation + func() string {
								if strings.TrimSpace(example) != "" {
									return " Example: " + example
								}
								return ""
							}()),
						})
					}
				}
				return items, nil
			}
		}
	}

	return nil, fmt.Errorf("timed out waiting for OpenClaw response")
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func abortOpenClawSession(openclawBin, sessionKey string) {
	sessionKey = strings.TrimSpace(sessionKey)
	if sessionKey == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out map[string]any
	_ = runOpenClaw(ctx, openclawBin, "chat.abort", map[string]any{"sessionKey": sessionKey}, &out)
}

func main() {
	cfg := loadConfig()
	tracker := &requestTracker{m: map[string]inflightRequest{}}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		writeJSON(w, 200, map[string]any{"ok": true, "connected": true})
	})
	mux.HandleFunc("/oauth/start", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		writeJSON(w, 200, map[string]any{"ok": true, "mode": "openclaw-bridge", "message": "OAuth disabled in bridge mode"})
	})
	mux.HandleFunc("/abort", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			cors(w)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			cors(w)
			writeJSON(w, 405, map[string]any{"ok": false, "error": "method not allowed"})
			return
		}
		cors(w)
		body, _ := io.ReadAll(r.Body)
		var in struct {
			RequestID string `json:"requestId"`
		}
		if err := json.Unmarshal(body, &in); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid json"})
			return
		}
		rid := strings.TrimSpace(in.RequestID)
		if rid == "" {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "missing requestId"})
			return
		}
		req, ok := tracker.take(rid)
		if ok {
			req.cancel()
			go abortOpenClawSession(cfg.OpenClawBin, req.sessionKey)
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("/explain", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			cors(w)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			cors(w)
			writeJSON(w, 405, map[string]any{"ok": false, "error": "method not allowed"})
			return
		}
		cors(w)
		body, _ := io.ReadAll(r.Body)
		var in struct {
			Text         string `json:"text"`
			SessionKey   string `json:"sessionKey"`
			UserLanguage string `json:"userLanguage"`
			RequestID    string `json:"requestId"`
		}
		if err := json.Unmarshal(body, &in); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "invalid json"})
			return
		}
		in.Text = strings.TrimSpace(in.Text)
		if in.Text == "" {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "missing text"})
			return
		}
		sessionKey := strings.TrimSpace(in.SessionKey)
		if sessionKey == "" {
			sessionKey = cfg.SessionKey
		}
		// Fixed single session key mode: prevent session explosion.
		requestID := strings.TrimSpace(in.RequestID)
		if requestID == "" {
			requestID = fmt.Sprintf("RID-%d-%d", time.Now().UnixMilli(), time.Now().UnixNano()%1000000)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
		tracker.set(requestID, inflightRequest{cancel: cancel, sessionKey: sessionKey})
		defer func() {
			tracker.del(requestID)
			cancel()
		}()

		items, err := explainViaOpenClaw(ctx, cfg.OpenClawBin, in.Text, sessionKey, in.UserLanguage, requestID)
		if err != nil {
			if ctx.Err() == context.Canceled {
				writeJSON(w, 499, map[string]any{"ok": false, "error": "request canceled"})
				return
			}
			writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "items": items, "requestId": requestID})
	})

	addr := "127.0.0.1:" + cfg.Port
	log.Printf("yt-explain-go bridge listening on http://%s", addr)
	log.Printf("mode: openclaw-bridge (no OAuth), default sessionKey=%s", cfg.SessionKey)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
