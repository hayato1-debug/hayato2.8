# Mahiru Memory Garden v2 — Admin + MongoDB publishing

This is an upgraded copy of the supplied static site. It adds an `/admin/` publishing page, a Python FastAPI backend, MongoDB GridFS storage, protected uploads, and public read-only image/music feeds. It also disables upload controls on the public pages and adds a reduced-motion option.

## Important deployment note
The live GitHub Pages site cannot run Python or connect directly to MongoDB. Deploy the `backend/` folder to a Python host (for example, Render/Railway/Fly.io) and create a MongoDB Atlas database. Then set the backend environment variables and put the backend's HTTPS URL in `config.js`. I cannot deploy it or connect your private database without access to your hosting account and database credentials. **Do not send those secrets in chat or put them in `config.js`.**

## Backend setup
1. Create a MongoDB Atlas cluster and database user. Restrict network access to your backend host where practical.
2. In `backend/`, install `requirements.txt` and copy `.env.example` values into the host's environment-variable settings. Do not commit `.env`.
3. Set `MONGODB_URI`, `MONGODB_DB`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, and `ALLOWED_ORIGINS`. `ALLOWED_ORIGINS` should include the exact GitHub Pages origin `https://hayato1-debug.github.io` (no repo path). Use long unique secrets.
4. Deploy with `uvicorn main:app --host 0.0.0.0 --port $PORT`. The provided `Procfile` is compatible with common Python hosts.
5. Visit `https://YOUR-BACKEND/api/health`; it should return `{"status":"ok"}` once MongoDB is configured.

## Frontend setup
1. Edit `config.js` and set `window.MAHIRU_API_BASE = "https://YOUR-BACKEND";` (no trailing slash). This URL is public; it is **not** a secret.
2. Commit/publish the folder contents to the GitHub Pages repository. The admin page is at `https://hayato1-debug.github.io/Mahiru_shinna/admin/` for a project Pages site.
3. Open `/admin/`, sign in with the backend environment credentials, and upload images or audio. Public gallery/music feeds are read-only.

## Security behaviour
- Upload endpoints require a signed, short-lived bearer token (30 minutes).
- Username/password and MongoDB URI exist only in backend environment variables.
- Files are stored in MongoDB GridFS; public media endpoints serve published media only.
- The `/admin/` page itself is not secret. Security is enforced by the backend, not by hiding the URL.
- This starter does not include delete/unpublish UI, password-reset, multi-admin accounts, or server-side rate limiting. Add those before treating it as a production service. Use HTTPS and strong unique credentials.

## Existing local data
Your old browser's IndexedDB gallery, albums, and tracks are not automatically migrated into MongoDB. Use the new admin page to publish the media you want available to everyone. Existing local data remains in that browser unless you clear it.

## Limits
Uploads are limited by `MAX_UPLOAD_MB` (default 12 MB). Public feeds list up to 500 images and 200 tracks.


## AI Chat + Ideogram Image Studio
The navbar now includes **AI Chat** and **AI Image Studio**. Both call the FastAPI backend; API keys are read only from backend environment variables.

Set these extra environment variables on your backend host:
- `GROQ_API_KEY`: your Groq secret key.
- `GROQ_MODEL`: model ID enabled for your Groq account (default in this project: `openai/gpt-oss-20b`; change if your account uses another model).
- `IDEOGRAM_API_KEY`: your Ideogram API key.

The chat endpoint is `POST /api/ai/chat`; image generation is `POST /api/ai/image`. The public AI Chat is available directly from the navbar and does not require admin sign-in; it uses a Mahiru-inspired fictional persona and has a basic per-IP request limit. Image Studio still requires a valid admin bearer token, so sign in at `/admin/` in the same browser tab before generating images. Image Studio stores generated image bytes in MongoDB GridFS and returns a media URL; generated images are not automatically listed in the public gallery. Current code includes small per-IP in-memory rate limits (12 public chat requests/minute and 3 image requests/minute per backend process). These are starter safeguards only: before production, add persistent/gateway rate limiting, spend alerts, and usage monitoring. Keep the admin credentials private because the same admin login controls uploads and AI-credit usage. Never commit actual API keys to GitHub.

Groq chat docs: https://console.groq.com/docs/api-reference
Ideogram API docs: https://developer.ideogram.ai/ideogram-api/api-overview


### Public Mahiru AI Chat
The navbar `AI Chat` opens a chat window where visitors can talk with a gentle, thoughtful, slightly shy Mahiru-inspired AI persona. Chat requests use the backend Groq key and do not require admin login. Because this makes Groq usage public, the included per-IP limit is only a basic safeguard; configure provider spending limits and persistent rate limiting or add account-based quotas before sharing widely.
