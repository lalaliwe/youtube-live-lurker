# YouTube Live Lurker
<p align="center">
  <img width="256" height="256" alt="icon-256" src="https://github.com/user-attachments/assets/17ea383e-a676-464f-b083-f7a2192ad6f7" />


YouTube Live Lurker is a Chrome extension made by and for VTuber fans. It watches the YouTube channels you choose, opens your top-priority stream when it goes live, and can notify you for the rest.

The optional desktop dashboard adds a Holodex-style live/upcoming view for VTuber channels tracked by Holodex.

This project is fan-made and is not affiliated with YouTube, Google, Holodex, or any VTuber agency.

## What the extension does

- Rank `#1`: checks every 5 seconds, opens/focuses the stream tab, and reopens it if you close the tab while the stream is still live.
- Rank `#2+`: checks every 30 seconds and shows a notification when a live stream is found.
- Click any channel card in the popup to check it now and open/focus the stream if it is live.
- Scheduled/upcoming YouTube waiting rooms are not treated as live unless YouTube reports playback-ready live data.

Chrome must stay open. Sleep mode pauses checks.

## What uses API keys

| Feature | API key? | Used for | Not used for |
| --- | --- | --- | --- |
| Main live monitoring | No | Checks `https://www.youtube.com/channel/<channel-id>/live` | YouTube Data API quota |
| YouTube Data API key | Optional | Cleaner channel name/avatar while adding channels, especially when public metadata fails | Live detection |
| Holodex API key | Optional | Dashboard live/upcoming cards, thumbnails, titles, countdowns, member-only filtering, and a fallback live lookup if YouTube fetch fails | The normal 5-second / 30-second live polling loop |
| Dashboard bridge token | Local only | Authenticates extension ↔ dashboard on `127.0.0.1` | Any web API |

API keys are stored locally:

- Extension settings live in Chrome extension local storage.
- Dashboard settings live in Electron user data, outside this repository.
- The packaged installer does not include your API keys or bridge token.

## Install the main extension

### Easy release route

1. Open the project’s **GitHub Releases** page.
2. Download the extension source ZIP or release ZIP.
3. Extract it somewhere permanent, such as `Documents\YouTube Live Lurker`.
4. Open `chrome://extensions`.
5. Turn on **Developer mode**.
6. Click **Load unpacked**.
7. Select the extracted project folder.
8. Open the extension popup and add YouTube channel URLs.

### CLI route

```powershell
git clone https://github.com/<your-user>/youtube-live-lurker.git
cd youtube-live-lurker
```

Then load the folder from `chrome://extensions` with **Load unpacked**.

If `git` works in normal PowerShell but not in your editor terminal, restart the editor or temporarily add Git to that terminal:

```powershell
$env:Path = 'C:\Program Files\Git\cmd;' + $env:Path
```

## Use the extension

1. Paste a YouTube channel URL, handle URL, or channel URL into **Add channel**.
2. Use the arrows to sort the watchlist.
3. Put your must-open channel at `#1`.
4. Keep Chrome open.

`#1` always has auto-open priority. Channels below it use notifications and can also be opened from the popup.

## Optional desktop dashboard

The dashboard is optional. The extension works without it.

The dashboard:

- Connects to the extension through a local WebSocket bridge.
- Shows live and upcoming streams for your extension watchlist.
- Uses Holodex for VTuber schedule metadata.
- Opens clicked streams in your default browser.
- Can sync extra YouTube channel IDs into the extension watchlist.

### Easy installer route

1. Open the project’s **GitHub Releases** page.
2. Download `YouTube Live Lurker Dashboard Setup <version>.exe`.
3. Run the installer.
4. Open the dashboard.
5. Open **Dashboard settings**.
6. Paste your Holodex API key if you want Holodex schedule data.
7. Copy the dashboard **Bridge token**.
8. Open the extension popup.
9. Open **API and dashboard settings**.
10. Paste the bridge token and save.
11. Reload the extension once from `chrome://extensions`.

### CLI/dependency route

Install Node.js LTS first. Then:

```powershell
cd optional/dashboard
npm install
npm start
```

If `npm` works in normal PowerShell but not in your editor terminal, restart the editor or temporarily add Node:

```powershell
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
```

### Build the dashboard installer

```powershell
cd optional/dashboard
npm ci
npm run dist
```

The installer is written to `optional/dashboard/dist/`.

The installer uses the same project icon as the Chrome extension. The Windows installer icon lives at `optional/dashboard/build/icon.ico`, generated from the PNG files in `icons/`.

Before making a GitHub Release:

- Do not commit or upload API keys.
- Do not copy Electron user data into the repository.
- Use the generated installer from `optional/dashboard/dist/`.
- Upload the installer artifact to GitHub Releases for non-technical users.

## Holodex usage and terms

Holodex is used only for the optional VTuber dashboard metadata and for a fallback live lookup when YouTube’s public page fetch fails.

This project follows Holodex requirements in these ways:

- Holodex requests use the `X-APIKEY` header.
- The dashboard requests live/upcoming stream metadata from `https://holodex.net/api/v2/live`.
- Holodex data is not used as the high-frequency live polling loop.
- Dashboard refresh is limited to app startup, every 60 seconds, manual refresh, and extension watchlist changes.
- The UI displays “Data provided by Holodex” with a Holodex link.
- Source notices refer to the Holodex Public License and warranty disclaimer.
- The project does not charge for access to Holodex API data.
- Users provide their own Holodex API key; no shared key is bundled.

See [NOTICE.md](NOTICE.md) and [optional/dashboard/NOTICE.md](optional/dashboard/NOTICE.md).

## Limits

YouTube’s `/live` page is a public web route, not an official live-status API. YouTube may change, throttle, or block it. On repeated check errors, the extension backs off to avoid hammering requests.

Holodex coverage is strongest for VTuber channels tracked by Holodex. Non-Holodex channels can still be watched by the extension, but may not show upcoming schedule cards in the dashboard.

## License

Code in this repository is released under the MIT License. See [LICENSE](LICENSE).

Holodex API data remains subject to the Holodex Public License and Holodex terms.
