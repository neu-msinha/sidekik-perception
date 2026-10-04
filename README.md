# sidekik-perception

Sidekik's eyes. It turns screen frames from the browser and the meeting bot into `screen.events`, short `ctx` lines for the agent, redacted keyframes and clips. Spec: `docs/DESIGN.md`. System design: `docs/ARCHITECTURE.md`.

Public host `ingest.sidekik.live` (frames WebSocket only), local port **8081**, Node ≥ 22.

## Run

```sh
pnpm install
docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d redis presidio-image-redactor
cp .env.example .env        # fill from the team vault
pnpm dev                    # watch mode
```

**Offline replay** of a capture session, with no teammates' services and no database:

```sh
pnpm dev:mock                          # ../sidekik-platform/dev/fixtures/capture_sabine.jsonl at 20x
pnpm dev:mock path/to/x.jsonl --speed 1
pnpm dev:mock --keep                   # keep serving after the replay
```

Fixture lines are `{"stream": "sk:…", "ev": <Envelope>}`, and each replay gets fresh session and event ids.

## Test

```sh
pnpm typecheck
pnpm test        # app.test.ts needs Redis (DB 13; override with TEST_REDIS_URL)
```

## Layout

| Path | What |
|---|---|
| `src/env.ts` | zod-validated env (`.env.example` lists every variable) |
| `src/app.ts`, `src/main.ts` | Wiring and process entry |
| `src/server.ts` | Fastify app and `/healthz` |
| `src/sessions.ts` | Per-session registry: lifecycle, off-record, replay sessions ignored |
| `src/consumers.ts` | Bus consumers: lifecycle, DOM events, `ask` commands |
| `scripts/dev-mock.ts`, `scripts/replay.ts` | Offline fixture replay |

## Deploy

`@sidekik/contracts` comes from a private GitHub repo, so the build needs a read-only GitHub token:

```sh
NPM_GITHUB_TOKEN=... docker build --secret id=NPM_GITHUB_TOKEN,env=NPM_GITHUB_TOKEN -t sidekik-perception .
```

On Railway, set `NPM_GITHUB_TOKEN` as a build variable; the Dockerfile also accepts it as a build arg. Only the install step uses the token, and the runtime image never contains it.

The image is `node:22-slim` with `ffmpeg`; `sharp` brings its own libvips. It runs as `node`, listens on `::` at `PORT`, and has a `/healthz` health check. Set every variable from `.env.example` in Railway.
