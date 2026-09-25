# Wedding Photo Gallery on Cloudflare Workers

A token/password-protected wedding photo gallery. The Worker handles access, gallery listing, uploads, image delivery, and admin deletion. Original files remain in a private pCloud folder; pCloud OAuth credentials are stored as Worker secrets.

## Features

- Open the gallery from a `?token=...` link or enter the same gallery token as a password. A signed, HttpOnly session cookie lasts 24 hours.
- Upload several images at once, including drag and drop.
- Browse a responsive image grid and a keyboard-navigable lightbox.
- Serve optimized pCloud thumbnails for the grid and a larger preview for the lightbox. Original downloads remain available.
- Optionally configure one admin token to enable deletion from the gallery.
- Keep the pCloud folder private; the Worker calls the EU pCloud API server-side.

## Configuration

1. Create a pCloud OAuth application and authorize it for the pCloud account that owns the target folder.
2. Set Worker variables:
   - `APP_NAME`: title displayed in the app.
   - `PCLOUD_API_BASE`: `https://eapi.pcloud.com` for EU accounts.
   - `PCLOUD_FOLDER_ID`: numeric pCloud folder ID.
3. Set Worker secrets:
   - `PCLOUD_ACCESS_TOKEN`: OAuth access token. Do not commit it or expose it in the browser.
   - `GALLERY_ACCESS_TOKEN`: guest access link/password.
   - `SESSION_SIGNING_KEY`: long random value used to sign session cookies.
   - `ADMIN_ACCESS_TOKEN` (optional): a distinct secret for the single admin. This is separate from the guest password; anyone holding it can delete gallery images.

Example local development secrets go in `.dev.vars` (ignored by git). Do not put production secrets in `wrangler.jsonc`.

```sh
npm install
npx wrangler secret put PCLOUD_ACCESS_TOKEN
npx wrangler secret put GALLERY_ACCESS_TOKEN
npx wrangler secret put SESSION_SIGNING_KEY
npx wrangler secret put ADMIN_ACCESS_TOKEN
npx wrangler dev
```

Set `PCLOUD_FOLDER_ID` in `wrangler.jsonc` or with `wrangler secret put` if the folder ID should also be hidden. The pCloud folder must be owned by the account connected through OAuth.

## Image delivery

The Worker requests a 400×400 pCloud thumbnail for the gallery and a 1600×1000 thumbnail for the lightbox, then proxies it to the browser. pCloud creates and caches the thumbnail on first request. The Worker uses its Cloudflare Images binding to transcode optimized variants to WebP. If pCloud cannot provide a thumbnail, the Worker optimizes the original when it is within the Images binding's 20 MB input limit; otherwise it serves the original as the preview fallback. The original endpoint always streams the original file as an attachment.

The Worker does not impose its own per-file limit and streams multipart uploads through to pCloud. Cloudflare's account-level request-size limit still applies.

## Routes

- `GET /api/session` — current session and app title
- `POST /api/session` — sign in using gallery or admin secret
- `POST /api/logout` — end local session
- `GET /api/gallery` — list image files directly in the configured pCloud folder
- `POST /api/upload` — stream multipart uploads to pCloud
- `GET /api/images/:fileid?size=thumb|display|original` — optimized image or original download
- `DELETE /api/images/:fileid` — admin-only permanent deletion from pCloud

The initial version supports images in the top level of one pCloud folder; it does not scan subfolders.
