# KaiOS Shared List

A collaborative shared list app that works on KaiOS phones, iPhones, and desktop browsers from the same codebase. Share a list with anyone via a link — changes sync the next time either person opens the list.

## Backend

AWS Lambda + API Gateway + DynamoDB. All endpoints are `POST` — see the comment in `lambda_function.py` for why.

### Sync model (offline-first)

There is no dedicated GET endpoint. `/list` is both your read and your write: you push whatever you have locally and get back the merged truth. The server merges using last-write-wins by `updated` timestamp per item.

Typical client flow:

1. **App open / login** — call `POST /me` to get the user's `list_names` index (name → list ID).
2. **Open a list** — call `POST /list` with local state (or `{}` if none). The server merges and returns the current list. Display the result.
3. **Edit offline** — mutate local state freely; bump `updated` timestamps on changed items.
4. **Back online** — call `POST /list` again with local state. The merge is idempotent: pushing unchanged data is a no-op.

This means the app works offline naturally — local state is always the working copy, and sync happens opportunistically.

### Sharing

Call `POST /share` with a `list_id` to accept a shared list. If the user already has a list with the same name, their local items are merged into the shared list and their old list is expired (TTL 30 days). After accepting, the shared `list_id` becomes the canonical ID for that name.

### Environment variables

| Variable | Description |
|---|---|
| `APP_NAME` | App identifier, used to name the auth cookie |
| `DYNAMODB_TABLE_NAME` | DynamoDB table name |
| `DOMAIN_NAMES` | Comma-separated allowed origins (e.g. `https://lists.elliscode.com`) |
| `ENCRYPTION_KEY` | 32-byte hex key used to encrypt list contents and hash email addresses |
| `SES_REGION` | AWS region for SES (default: `us-east-1`) |
| `SES_SENDER_EMAIL` | Verified SES sender address |
| `SES_REPLY_TO_EMAIL` | Reply-to address for OTP emails |
| `SES_TEMPLATE_NAME` | SES template name for OTP emails |
| `COOKIE_DOMAIN` | Domain set on the auth cookie |

Generate the `ENCRYPTION_KEY` with:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

### DynamoDB Obfuscation

By default, DynamoDB tables are encrypted at rest, but the application developer can still read the contents of the database. To prevent any PII being visible to the developer, the backend encrypts all sensitive fields written to DynamoDB using a custom XOR stream cipher with a SHA-256-derived keystream and a random nonce.

Email addresses are a special case: rather than being encrypted, they are stored as a keyed HMAC-SHA256 hash. This allows the server to look up a user by email without storing the address in recoverable form — even the developer cannot retrieve an email address from the database.

This obfuscation is not intended to be a replacement for serious encryption (AWS handles that at the storage layer). It is simply meant to prevent accidentally reading user data when browsing the database for debugging purposes.

It would be possible for a developer with access to the `ENCRYPTION_KEY` to manually decrypt the data, but this is not a realistic attack surface — the intent is to avoid inadvertently seeing what users put in their lists, not to protect against a malicious insider.

## Frontend

A single HTML/CSS/JS codebase (`frontend-v3/`) that runs in two modes — as a KaiOS app installed from the KaiOS Store, and as a normal web app in any browser. No framework, no build step, no bundler. Ships as static files.

### File structure

```
frontend-v3/
  index.html              # All panel markup lives here
  app.js                  # All application logic (single file)
  manifest.webmanifest    # KaiOS/PWA manifest; b2g_features for deeplinks
  css/
    root.css              # Layout, panels, responsive breakpoints, dark mode
    header.css            # Header bar + action buttons
    softkey.css           # KaiOS bottom softkey bar
    list.css              # List rows, options rows, nav-selected highlights
    input.css             # Floating-label input fields
    sheet.css             # Bottom sheet overlay
```

### Panel architecture

The app is a panel-based SPA. Every "screen" is a `<div class="panel">` in `index.html`. Only one panel is visible at a time via the `active="true"` attribute on the panel itself:

```css
.panel            { display: none; }
.panel[active="true"] { display: flex; }
```

Panels: `panel-email` → `panel-otp` → `panel-lists` → `panel-list` → `panel-new-item`. Plus `panel-new-list` and `panel-options` as overlays. Navigation between panels is handled entirely in `app.js` by functions like `showListsPanel()`, `showListPanel(name)`, etc. There is no router.

### Responsive breakpoints

The UI adapts purely by viewport width — no user-agent sniffing or feature detection for layout.

| Width | Target | Behaviour |
|---|---|---|
| ≤ 240px | KaiOS devices | Softkey bar visible at bottom; compact 10px/8px row padding; 14px font; D-pad navigation |
| 241px – 767px | iPhone / mobile browsers | Softkey hidden; header nav buttons (←, +, ✓) shown; edge-to-edge lists; 14px/16px row padding; 16px font; text selection disabled to prevent accidental tap-selection |
| ≥ 768px | Desktop browsers | Same single-column layout as mobile web; text selection re-enabled for copy/paste |

The `#softkey` bar is `display: flex` by default (KaiOS base style) and `display: none` inside `@media (min-width: 241px)` in `softkey.css`. Header action buttons are `display: none` by default and `display: flex` at 241px+ in `header.css`.

### Navigation

**KaiOS (D-pad):** Arrow keys move a `nav-selected="true"` attribute between `[nav-selectable="true"]` elements in the active panel. The three softkey labels (`#sk-left`, `#sk-center`, `#sk-right`) update via `updateListsSoftkey()` depending on what is focused. Pressing the center key or Enter triggers `interact(focused())` which calls `.click()` on the focused element.

**Touch / mouse (241px+):** Every interactive element has a `click` event listener. The `nav-selected` purple highlight is suppressed at 241px+ unless the user presses an arrow key, which adds `body.using-keyboard`. Switching back to mouse/touch removes it immediately via a `mousedown`/`touchstart` capture listener. This means the selection highlight appears exactly when it is useful and disappears when it isn't.

**Header buttons:** At 241px+ every panel header shows contextual action buttons (← back, + add, ✓ confirm, ⚙ settings). These call the same functions as the KaiOS softkey handlers so there is no duplicated logic.

### Offline / sync

`app.js` uses IndexedDB (via `openDB` / `dbSaveList` / `dbLoadAll`) to cache every list locally. On startup, the cached state is loaded and shown immediately before any network request completes. When the user opens a list, the cached version renders first and then a `POST /list` sync fires in the background — `softRenderListItems()` updates the view in-place while preserving the user's scroll position and focused element.

Local edits are debounced: `queueSync()` waits 1 second after the last change before calling `syncList()`, so rapid toggles don't hammer the API.

### Auth

1. `showEmailPanel()` → user enters email → `POST /otp` → server sends a 6-digit code via SES
2. `showOtpPanel()` → user enters code → `POST /login` → server sets an HttpOnly session cookie and returns a CSRF token in `x-csrf-token`
3. The CSRF token is stored in `localStorage` and sent in the body of every subsequent request
4. On any 403 response the CSRF token is cleared and the user is returned to the email panel

### Sharing

Share links take the form `https://lists.elliscode.com/?share=<list_id>`.

- **Web browser:** On load, `app.js` checks `window.location.search` for a `?share=` parameter via regex. If found, the list ID is stored in `pendingShare` and processed after login via `acceptShare()`.
- **KaiOS installed app:** `manifest.webmanifest` declares a `deeplinks` + `activities` entry under `b2g_features`. When a matching URL is tapped, KaiOS launches the app and fires a Web Activity. `navigator.mozSetMessageHandler('activity', ...)` captures the URL and stores the list ID in `pendingShare` before the app has finished initialising.

In both cases `pendingShare` is preserved across the login flow — if the session has expired, the user is re-authenticated and the share is accepted automatically on the next `showListsPanel()` call.

### KaiOS packaging

`manifest.webmanifest` includes the standard PWA fields plus a `b2g_features` block required by the KaiOS Store. Icons are provided at 56×56 and 112×112 (`icons/`). The manifest `<link>` in `index.html` is commented out during development to avoid unintended installs — uncomment it before submitting to the store.

### Dark mode

Toggled by the Display Mode setting in the options panel. The choice is saved to `localStorage`. `applySettings()` adds/removes the `body.dark` class, and all dark-mode styles are `body.dark` selectors in `root.css` and `list.css`. There is no `prefers-color-scheme` media query — the setting is always explicit user choice.