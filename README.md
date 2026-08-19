# Better Tab Unload

Chrome extension (Manifest V3) that shows a cached screenshot while a discarded tab is
restored, so switching back to a tab Chrome unloaded looks instant instead of blank.

📖 **[Documentation](https://rennerdo30.github.io/better-tab-unload/)**

## Why

Chrome's Memory Saver discards background tabs to free RAM. The tab stays in the tab strip,
but the page behind it is gone. Clicking back to it gives you a white screen while Chrome
re-fetches and re-renders the page — often for a second or more, and it reads as though the
browser broke.

Better Tab Unload keeps a recent screenshot of each tab you visit and paints it back while
the real page reloads. You get the previous rendering immediately, and it is swapped for the
live page as soon as that page finishes loading.

It does **not** discard tabs itself. Chrome decides that; this extension only improves what
you see when a discarded tab comes back.

## What it does

- Captures a JPEG screenshot of the active tab after it finishes loading, via
  `chrome.tabs.captureVisibleTab`.
- Stores screenshots in IndexedDB, keyed both by normalized URL and by tab ID.
- Detects a discarded tab being reactivated and shows the screenshot through a short-lived
  interstitial page (`restore.html`), then navigates to the real URL with
  `location.replace()` so the Back button still works.
- Falls back to a content-script overlay drawn on top of the loading page when the
  interstitial is not viable.
- Removes the placeholder once the real document reaches `readyState: complete`, with a
  short fade and several layered safety timeouts so a placeholder can never get stuck.
- Deletes screenshots older than 7 days, collapses duplicate URL keys, and drops per-tab
  records when a tab closes.
- Ships an options page to inspect, delete, and clear stored screenshots.

Pages under `chrome://`, `chrome-extension://`, `about:`, `edge://`, `brave://`,
`devtools://`, `view-source:`, and `file://` are skipped entirely.

## Privacy

Screenshots and URLs **never leave your machine**. They live only in the extension's local
IndexedDB database inside your browser profile. There is no backend, no telemetry, and no
sync — the source contains no `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon` call
and no external URL at all. `host_permissions` exists so the extension can read pixels from
and inject an overlay into the pages you visit, not to talk to any server.

A screenshot is a picture of a rendered page, so it can contain whatever was on screen.
Treat the database as sensitive: use **Clear All** on the options page to wipe it, and note
that uninstalling the extension deletes it too.

One caveat worth reading before you enable debugging: `DEBUG_LOGS` writes the full URL of
every tab the extension touches, with timestamps, to the service worker console. See
[Privacy](https://rennerdo30.github.io/better-tab-unload/guides/privacy/).

## Install

Not on the Chrome Web Store — load it unpacked:

1. `git clone https://github.com/rennerdo30/better-tab-unload.git`
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this project folder (the directory containing
   `manifest.json`).

There is no build step and no runtime dependency. Chrome only reads the files referenced by
`manifest.json`, so the `docs/` and `.github/` directories are ignored by the browser.

### Verify

Open a site and let it load, switch away for a few seconds, then discard the tab from
`chrome://discards` (**Urgent Discard**) and switch back. You should see the previous
rendering rather than a blank page. The options page lists what has been captured.

## Usage

Nothing to operate — it works in the background once loaded. The options page
(**Details → Extension options** on `chrome://extensions`) shows every stored screenshot
with its URL, capture time, and an approximate total size, and lets you delete individual
entries or clear everything.

## Configuration

There is no settings UI and there are no environment variables. Everything tunable is a
named constant at the top of a source file; edit it and reload the extension.

| Constant | File | Default | Purpose |
| --- | --- | --- | --- |
| `DEBUG_LOGS` | `background.js`, `content.js` | `false` | Opt-in verbose tracing. Must be enabled in both files. Logs include full page URLs. |
| `CAPTURE_COOLDOWN_MS` | `background.js` | `1200` | Minimum gap between captures of one tab, to stay under Chrome's capture rate limit. |
| `TAB_CACHE_MAX_AGE_MS` | `background.js` | 30 min | Lifetime of the in-memory per-tab screenshot cache. |
| `RELOAD_STATE_MAX_MS` | `background.js` | 15 s | How long a tab stays marked as "reloading after discard". |
| `MAX_AGE_MS` | `storage.js` | 7 days | Screenshot retention; enforced by the hourly cleanup. |
| `POST_LOAD_HOLD_MS` / `OVERLAY_FADE_MS` | `content.js` | `100` / `140` | Overlay hold and fade after the page completes. |
| `NAVIGATION_FAILSAFE_MS` | `restore.js` | `2000` | Interstitial navigates anyway if the screenshot lookup stalls. |
| `SKIP_URL_PATTERNS` | `background.js` | see above | URL schemes the extension ignores completely. |

Full list with explanations:
[Configuration](https://rennerdo30.github.io/better-tab-unload/getting-started/configuration/).

## Tech stack

- **Chrome Extension Manifest V3** — service worker background script, `document_start`
  content script, extension pages for the interstitial and options.
- **Vanilla JavaScript, HTML, CSS** — no framework, no bundler, no build step, zero runtime
  dependencies.
- **IndexedDB** — two object stores (`screenshots` by URL, `tabScreenshots` by tab ID) with
  timestamp indexes for age-based cleanup, wrapped in `storage.js`.
- **Chrome APIs** — `tabs`, `scripting`, `windows`, `runtime` messaging.
- **Docs** — Astro Starlight with the Galaxy theme, in `docs/`, deployed to GitHub Pages.

## Development

```bash
npm run check          # node --check on every extension source file
npm run install:docs   # install docs dependencies
npm run dev            # local docs preview
npm run build          # production docs build into docs/dist
```

Edit a file, click the reload icon on `chrome://extensions`, and re-run your repro. There is
no test suite; `npm run check` is a syntax gate, not a test.

For the restore state machine, the message protocol, and the stale-`tab.url` guards that
most of the complexity exists for, see
[How It Works](https://rennerdo30.github.io/better-tab-unload/guides/architecture/) and
[Troubleshooting](https://rennerdo30.github.io/better-tab-unload/guides/troubleshooting/).

## License

MIT — see [LICENSE](LICENSE).
