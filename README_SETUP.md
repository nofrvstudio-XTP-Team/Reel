# XTP jp — reliable GitHub ingest setup

This version deliberately does NOT use public Piped/Invidious resolvers at runtime.
The phone app plays files you control from R2, while GitHub Actions handles ingest.

## What runs where

- GitHub Pages: `index.html` (the phone/PWA frontend)
- GitHub Actions: checks the configured YouTube channels and ingests missing videos
- Cloudflare R2: stores `youtube/<VIDEO_ID>.mp4`
- Cloudflare Worker: serves `/media/<VIDEO_ID>` with CORS + byte-range support

Existing media keeps playing even if a later YouTube ingest run fails.

## 1. Create R2

Create a bucket named `xtp-native-media`.
Create R2 S3 credentials and add these GitHub repository Secrets:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Optional repository Variable:

- `R2_BUCKET` (defaults to `xtp-native-media`)

## 2. Deploy the Worker from GitHub

Create a Cloudflare API token that can deploy Workers and access the R2 binding, then add:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Run Actions -> `Deploy media Worker` -> Run workflow.
Copy the resulting workers.dev URL into `xtp-config.json` as `mediaBaseUrl`.

## 3. Pick channels

Edit only `xtp-config.json`.
`channels` is the whitelist used by GitHub Actions and, on first setup, by the app.

The included example is:
`https://www.youtube.com/@AttackonTitan_OfficialChannel`

## 4. YouTube API key in the app

The app still uses YouTube Data API for public channel/video metadata.
Either:

- paste your HTTP-referrer-restricted key once in the app; or
- put it in `youtubeApiKey` in `xtp-config.json` (visible client-side, so keep the key restricted to your GitHub Pages origin and YouTube Data API v3).

## 5. Run ingest

Actions -> `Ingest YouTube media` -> Run workflow.
The scheduled workflow also runs every 2 hours.

It scans recent uploads, skips files already in R2, downloads only missing videos,
normalizes them to H.264/AAC <=720p with faststart for phone playback, then uploads them.

## Optional reliability secrets

`YOUTUBE_COOKIES_B64`:
Base64 of a Netscape-format cookies.txt, only if public YouTube extraction requires login/bot verification.
Using account cookies with yt-dlp can carry account risk; do not add them unless needed.

`YTDLP_PROXY`:
Optional proxy URL for yt-dlp if the GitHub runner IP is blocked.

## Important

No method that extracts third-party YouTube media can be guaranteed forever because YouTube changes its playback checks.
This setup is designed so extraction failures do not break the app: already-ingested media stays available and the workflow fails visibly instead of the phone feed spinning through dead public resolvers.
Use it only for media you have permission to store and serve.
