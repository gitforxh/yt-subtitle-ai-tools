# yt-explain-go

Local Go helper for transcript word-by-word explanation via **OpenClaw bridge mode**.

## What it does

- Starts local HTTP server (default `127.0.0.1:18794`)
- No OAuth flow
- Uses `openclaw gateway call chat.send/chat.history` internally
- Exposes `POST /explain` for your extension

## Endpoints

- `GET /health`
- `GET /status`
- `POST /explain` body: `{ "text": "...", "sessionKey": "optional" }`
- `GET /oauth/start` returns bridge-mode info (OAuth disabled)

## Setup

1. Copy env template

```bash
cp .env.example .env
```

2. Export env vars (or use direnv)

- `PORT` (default `18794`)
- `BASE_URL` (default `http://127.0.0.1:18794`)
- `SESSION_KEY` (default `ext-transcript`)
- `OPENCLAW_DIR` (optional; working directory for `openclaw gateway call`)

3. Run

```bash
go run .
```

4. Test

```bash
curl -s http://127.0.0.1:18794/health
curl -s -X POST http://127.0.0.1:18794/explain \
  -H 'content-type: application/json' \
  -d '{"text":"日本語の文を説明して"}'
```

## Notes

- Make sure `openclaw` CLI is available in PATH for the helper process.
- If needed, pass `sessionKey` from extension per request to isolate context.
- For macOS service install/start/stop, use `./service.sh`.

## Installed service (example)

- Label: `com.yt-explain-go`
- Plist: `~/Library/LaunchAgents/com.yt-explain-go.plist`
- Port: `18794`
- Auto-start: enabled (`RunAtLoad` + `KeepAlive`)
