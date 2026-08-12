# news_agregator

News aggregator with a Vercel-friendly Node/Express backend and a static frontend.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` by default. Set `PORT` if you need a different port.

## Production path

- Frontend: static `index.html`, `css/style.css`, `js/main.js`
- API: `server.js`
- Deployment: Vercel via `vercel.json`

## API

- `GET /health`
- `GET /api/sources`
- `GET /api/search?q=...&source=...&view_all=true&refresh=true`
- `POST /api/translate`

## Environment

- `PORT` - server port
- `ALLOWED_ORIGIN` - CORS origin, defaults to `*`
- `CRON_SECRET` - required on Vercel; cron sends `Authorization: Bearer <CRON_SECRET>`
- `SEARCH_DEADLINE_MS` - `/api/search` wait budget (default `8000`)
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_*`) - optional shared L2 cache. On Vercel without Redis, Runtime Cache is used when `@vercel/functions` is available.

`vercel.json` schedules `GET /api/cron/warmup` every 5 minutes (Pro). Hobby only allows a daily cron — change the expression or ping the same URL from an external scheduler.

## Notes

- The Node/Vercel stack is the canonical runtime.
- The legacy FastAPI experiment was archived under `archive/fastapi/`.
