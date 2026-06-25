# YouTube Live Lurker Dashboard

Optional Electron dashboard for YouTube Live Lurker.

The browser extension works without this app. Use the dashboard if you want a Holodex-style live/upcoming feed for the channels in your extension watchlist.

## What it does

- Connects to the already-open extension through an authenticated localhost WebSocket bridge.
- Shows live and upcoming streams from your extension watchlist.
- Uses Holodex for VTuber metadata: thumbnail, title, channel name, start time, and member-only topic data.
- Opens clicked streams in your default browser.
- Syncs optional extra YouTube channel IDs into the extension watchlist.

No Playwright browser is launched. No browser remote-debugging port is needed.

## Easy installer route

For non-technical users, use the GitHub Release installer:

1. Download `YouTube Live Lurker Dashboard Setup <version>.exe`.
2. Run the installer.
3. Open **YouTube Live Lurker Dashboard**.
4. Open **Dashboard settings**.
5. Paste your Holodex API key if you want Holodex schedule data.
6. Copy the **Bridge token**.
7. Open the Chrome extension popup.
8. Open **API and dashboard settings**.
9. Paste the bridge token and save.
10. Reload the extension once from `chrome://extensions`.

The installer does not include API keys or saved dashboard settings.

## CLI route

Install Node.js LTS first. Then:

```powershell
cd optional/dashboard
npm install
npm start
```

If `npm` is not recognized inside your editor terminal:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
```

## Build a Windows installer

```powershell
cd optional/dashboard
npm ci
npm run dist
```

Output appears in:

```text
optional/dashboard/dist/
```

The installer uses Electron Builder with NSIS. The setup icon is `build/icon.ico`, generated from the same PNG icons used by the Chrome extension.

## Release checklist

Before uploading a release:

- Confirm `npm run dist` finished cleanly.
- Upload `optional/dashboard/dist/YouTube Live Lurker Dashboard Setup <version>.exe` to GitHub Releases.
- Do not upload local Electron user data.
- Do not commit or upload Holodex API keys, YouTube Data API keys, or bridge tokens.
- Keep `NOTICE.md` with the dashboard source and package.

Dashboard settings are stored by Electron in user data, not in this app folder. The `electron-builder` `files` list packages only app source, renderer files, `NOTICE.md`, and `package.json`.

## Holodex usage

Holodex is optional. Without a Holodex key, the dashboard still connects to the extension but cannot show Holodex schedule data.

With a key, the dashboard calls:

```text
GET https://holodex.net/api/v2/live
X-APIKEY: <your key>
```

It asks for live/upcoming stream data, includes `live_info`, and requests up to 720 hours so streams scheduled within the next 30 days can appear.

The dashboard refreshes:

- On startup
- Every 60 seconds
- When you click refresh
- When extension watchlist channel IDs change

The extension also receives the Holodex key from the dashboard for one narrow fallback: if YouTube’s public `/live` page fetch fails, the extension can ask Holodex whether that channel has a current live stream. That fallback only works for Holodex-tracked channels.

Holodex is not used for the extension’s normal 5-second / 30-second polling loop.

## Holodex attribution and terms

This app is made by and for VTuber fans, and uses Holodex with attribution:

- The footer displays “Data provided by Holodex” with a link to Holodex.
- `NOTICE.md` refers to the Holodex Public License.
- `NOTICE.md` includes the Holodex warranty disclaimer notice.
- The app does not charge for access to Holodex API data.
- Users provide their own Holodex API key; no shared key is bundled.

Holodex coverage depends on Holodex tracking that channel. Non-Holodex channels can still be watched by the extension, but may not show scheduled stream cards here.

## Local bridge security

The bridge binds to:

```text
127.0.0.1:38517
```

It rejects connections without the dashboard token. The token is local-only and is not a web API key.

## License

Dashboard code is MIT licensed as part of the main repository.

Holodex API data remains subject to the Holodex Public License and Holodex terms. See [NOTICE.md](NOTICE.md).
