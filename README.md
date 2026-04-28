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

## Notes

- The Node/Vercel stack is the canonical runtime.
- The legacy FastAPI experiment was archived under `archive/fastapi/`.
