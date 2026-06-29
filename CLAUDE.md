# kaios-shared-list

A shared list app (backend + frontend) running on AWS Lambda, fronted by API Gateway, with a plain HTML/CSS/JS frontend deployed to S3 and packaged as a KaiOS app.

## Architecture

```
DNS (lists.elliscode.com) → API Gateway → Lambda → DynamoDB
                                  ↑
                S3 (static frontend) / KaiOS store package
```

## Project structure

```
backend/
  lambda/
    lambda_function.py          # Entry point + router
    shared_list/
      shared_list.py            # Route handlers
      utils.py                  # DynamoDB helpers, auth, utilities
      list_merge.py             # Merge logic (last-write-wins by timestamp)
      input_validation.py       # Schema validator + schemas
      logger.py                 # Simple logger
  dev-release.sh                # Zip + deploy to dev Lambda
  prod-release.sh               # Zip + deploy to prod Lambda
  pyproject.toml                # Dependencies (boto3) + black config
frontend-v3/
  index.html                    # Single-page app shell
  app.js                        # All JS logic
  css/
    root.css                    # Base layout, panel system, responsive breakpoints
    header.css                  # Header bar
    softkey.css                 # KaiOS softkey bar
    input.css                   # Input fields
    list.css                    # List rows
    sheet.css                   # Bottom sheet / modal
  manifest.webmanifest          # KaiOS app manifest (linked only for KaiOS builds)
  kaiads.v5.min.js              # KaiOS ads SDK
  release.sh                    # Sync to S3 (web deployment)
  kaios-release.sh              # Zip for KaiOS store submission
openapi.yaml                    # API spec — keep in sync (see rule below)
```

## Rules

**Whenever you add, remove, or change a route in `backend/lambda/lambda_function.py`, update `openapi.yaml` at the project root to match.**

This includes: new paths, changed request bodies, changed response shapes, new status codes, auth requirement changes.

## Deploying

```bash
# Backend — dev
sh backend/dev-release.sh

# Backend — prod
sh backend/prod-release.sh

# Frontend — web (S3 sync)
cd frontend-v3 && sh release.sh

# Frontend — KaiOS store (zip)
cd frontend-v3 && sh kaios-release.sh
```

## Frontend

Plain HTML/CSS/JS, no framework. Works in two modes from the same codebase:

- **KaiOS app** — 240px-wide screen, D-pad/key navigation, softkey bar, KaiOS ads
- **Web browser** — responsive layout (241px–767px mobile, 768px+ desktop split view), touch-capable

### CSS layout approach

The base styles (no media query) target KaiOS at 240px and use **natural document flow** — `html`/`body` are `height: auto; overflow: auto;` so the document scrolls natively. This is required because KaiOS's browser only scrolls reliably at the document level, not inside overflow containers.

The `min-width: 241px` media query switches to the **fixed-height panel system** — `html`/`body` become `height: 100%; overflow: hidden;`, panels are viewport-height, and scroll happens inside `.panel-content`. This is the standard web app scroll pattern used on larger screens.

Do not apply `overflow: hidden` or fixed heights to `html`/`body` in the base (KaiOS) styles.

### D-pad navigation

Elements marked `nav-selectable="true"` are included in D-pad focus cycling. Key rules:

- `setFocus(el)` in `app.js` lazily adds `tabindex="0"` to non-natively-focusable elements (e.g. `<li>`) before calling `.focus()`. Do not skip this — without it, KaiOS's Enter key may not fire on the right element.
- `scrollToVisible(el)` detects which mode it's in: if `.panel-content` has `overflow-y: visible` (KaiOS doc flow), it uses `window.scrollBy()`; otherwise it scrolls the container. When the first nav-selectable or the ad is focused, it snaps to `window.scrollTo(0, 0)` to keep the panel header visible.
- `showPanel()` calls `window.scrollTo(0, 0)` to reset page position on every panel switch.
- Backspace (hardware back button) only calls `handleSoftLeft()` on non-root panels. On `panel-lists` and `panel-email` it does NOT `preventDefault`, letting KaiOS exit the app.

### KaiOS ads

- Ads only load when `window.location.hostname.endsWith('.localhost')` (the packaged app origin). Do not use `window.location.protocol === 'app:'` — that's the old KaiOS 2.x format.
- `preloadAd()` fetches an ad and stores it in `_preloadedAd`. `displayAd()` consumes the preload (or falls back to immediate load), then calls `preloadAd()` to queue the next one.
- `displayAd()` is gated by `_lastAdTime`: it no-ops if fewer than 5 minutes have elapsed since the last display. This prevents excessive ad requests when navigating back to the main menu repeatedly.
- Call `preloadAd()` on `DOMContentLoaded` so the ad is ready by the time the user logs in and reaches the lists panel.
- The KaiOS developer portal app name (`app:` field in `getKaiAd`) is `kaiosshaaredlist` (note the double-a — this is the registered name).

### Sharing & app handoff

Two things were tried and abandoned before landing on the current approach:
- **Native deep linking** (`b2g_features.deeplinks` regex/paths matching) — depends on which `AppsServiceDelegate` implementation (`.jsm` vs `.sys.mjs`) a given firmware build ships, so a share link tapped in SMS/Email would inconsistently open the system browser instead of the app.
- **`WebActivity('open-share', ...)`** invoked from the plain web page, intended to make the OS launch the installed app directly — failed on-device with a native "can't open list" error (not a message this app produces). Most likely `NO_PROVIDER`: unprivileged websites can probably only invoke built-in activity names (`view`, `share`, `pick`, etc.), not a custom one like `"open-share"`.

**Current approach — a two-screen tap-to-join flow, fullscreen, specifically for shares opened in a KaiOS browser:**

- Cookies/session ARE shared between the system browser's rendering of the web app and the real installed app — there's no storage isolation issue, and `POST /share` is a server-side, account-level operation anyway. The actual reason not to just let the user browse the full app inside the system browser is navigational: the Browser app doesn't pass real D-pad/keyboard events to arbitrary pages, it falls back to an on-screen mouse-cursor mode, which doesn't work well with this app's `nav-selectable`/`setFocus` keyboard-driven UI.
- So instead of trying to "launch" anything, when the web app loads with a `?share=` param on a KaiOS browser (sniffed via `navigator.userAgent` containing `"kaios"`), `isKaiosShareHandoff` gates a deliberately minimal flow:
  1. `#open-in-app-banner` shows fullscreen ("Click to add list →") — a single big tap target, no autofocus, nothing else rendered (the normal bootstrap is deferred until tapped).
  2. Tapping it starts the *normal* existing bootstrap (login/OTP if needed, then `acceptShare()`) — those screens render as the regular app UI, that part is unchanged.
  3. On successful join, `acceptShare()` checks `isKaiosShareHandoff` and shows the banner fullscreen again with a success message ("Added... to your lists. Please re-open the app.") instead of the normal `openList(name)` — telling the user to switch to the real app, where proper D-pad nav resumes, rather than continuing in the browser.
- Plain web/desktop/iOS/Android visitors never see any of this — the UA check excludes them entirely, they just get the normal app/site.

### Version bumping

The version string (e.g. `3.0.14`) appears in:
- CSS `<link>` cache-busters in `index.html`
- `<script>` cache-busters in `index.html`
- The Version row in the Options panel (`index.html`)
- `manifest.webmanifest` `b2g_features.version`

Use ⌘⇧H (find & replace all) to bump all occurrences at once.

## Auth flow

1. `POST /otp` — client submits email, server sends a 6-digit OTP via SES
2. `POST /login` — client submits email + OTP, server returns session cookie + `x-csrf-token` header
3. Authenticated routes — require session cookie + `csrf` field in request body

### CORS allowed origins

The Lambda function reads allowed origins from the `DOMAIN_NAMES` environment variable (comma-separated). This must include every origin that will make requests:

- `https://lists.elliscode.com` — web app
- `http://sharedlists.localhost` — KaiOS packaged app (derived from manifest `"id": "shared-lists"`)

If a new deployment target is added, update `DOMAIN_NAMES` in the Lambda config in AWS Console.

## DynamoDB key patterns

All items use a composite primary key `(key1, key2)`:

| key1           | key2        | Purpose                          |
|----------------|-------------|----------------------------------|
| `token`        | token_id    | Session token                    |
| `active_tokens`| user_id     | Set of active token IDs per user |
| `user`         | user_id     | User profile                     |
| `email`        | email       | Email → user_id lookup           |
| `otp`          | user_id     | One-time password for login      |
| `list`         | list_id     | Shared list data                 |

## Upload to KaiOS Developer portal

### Known issues

No known issues at this time

### Testing steps

1: Enter an email address to receive a one-time login pin. 2: Create a list. 3: Add items to your list, cross some off, delete some. 4: Open the app on another device, enter a different email address to receive a one-time login pin. 5: On the first device, share the link to the second device using SMS or email. 6: Click the link shared on the second device — it opens in the regular browser, showing a fullscreen "Click to add list" prompt (see Sharing & app handoff). Tap it, log in if needed, and confirm the success screen tells you to re-open the app — then re-open the real app and confirm the list now appears in its lists menu. 7: Modify the list on either device, then go back to the main menu and re-enter the list to see the shared list update from the other account / device.