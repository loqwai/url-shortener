# 2cb.pw

URL shortener and file host on Cloudflare Workers.

- `GET /<code>` - public. Redirects a short link, or streams a hosted file (supports Range).
  Add `?dl` to force a download.
- `GET /` - the UI. Drag-drop files, paste screenshots, shorten links, post text.
- `GET /up` - redirects to the UI. It exists as a path for Cloudflare Access to gate.
- `POST /api/*` - write endpoints. **Never open**: every write requires either a verified
  Cloudflare Access JWT (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` vars) or the `UPLOAD_TOKEN`
  secret sent as `X-Upload-Token`. With neither configured, writes are refused.

Links live in KV (`short-urls`), files in R2 (`2cb-files`). Links created before file
hosting are stored as bare URL strings and still resolve.

## Upload from the shell

    curl -X POST -H "X-Upload-Token: $KEY" --data-binary @photo.jpg \
      "https://2cb.pw/api/upload?name=photo.jpg&type=image/jpeg"

Files over 64 MB use the multipart endpoints (`/api/multipart/create`, `/part`, `/complete`),
which the web UI drives automatically.

## Develop

    npm install
    npm test
    npm run dev
