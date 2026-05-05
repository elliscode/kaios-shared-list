# frontend-v3 — KaiOS Shared List App

KaiOS-only frontend for the shared list backend at `lists.elliscode.com`. Single-file SPA, no frameworks, plain JavaScript compatible with Gecko v84.

## Structure

```
frontend-v3/
  index.html              — all four panels in one file
  app.js                  — navigation, API calls, state
  manifest.webmanifest    — KaiOS manifest (b2g_features)
  css/
    root.css              — base layout, panel show/hide, toast
    header.css            — purple title bars
    softkey.css           — fixed 30px bottom softkey bar
    input.css             — floating-label text inputs
    list.css              — list rows, crossed/selected states
  icons/
    kaios_56.png          — 56×56 app icon (add before publishing)
    kaios_112.png         — 112×112 app icon (add before publishing)
```

## Screens

| Panel | Description |
|-------|-------------|
| Sign In | Enter email address to request a one-time code |
| Enter Code | Type the 6-digit code from the email |
| My Lists | Scrollable list of all your lists |
| List view | Items in a single list; cross off or sweep |

Navigation is purely panel-based — no page loads. Panels are shown/hidden via an `active="true/false"` attribute, same pattern as the GPS location sharer reference app.

## D-pad & Softkey Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move focus between items |
| `Enter` / Center softkey | Activate focused item |
| Left softkey | Back (OTP → email, list view → lists) |
| Right softkey | Sweep (list view only — deletes all crossed items) |
| `Backspace` | Same as left softkey (when not in a text input) |

### Softkeys by screen

| Screen | Left | Center | Right |
|--------|------|--------|-------|
| Sign In | — | NEXT | — |
| Enter Code | Back | VERIFY | — |
| My Lists | — | OPEN | — |
| List view | Back | CHECK | Sweep |

## Auth Flow

1. Enter email → `POST /otp` sends a 6-digit code via SES
2. Enter code → `POST /login` returns an HttpOnly session cookie and an `x-csrf-token` response header
3. The CSRF token is saved to `localStorage` and sent as `"csrf"` in every subsequent request body
4. The session cookie is HttpOnly — the browser sends it automatically; JavaScript never touches it
5. On app load, if a CSRF token exists in `localStorage`, the app skips straight to the lists screen. A `403` response from any authenticated endpoint clears the token and returns to sign-in

## API Endpoints Used

Base URL: `https://lists.elliscode.com`. All requests are `POST` with `Content-Type: application/json` and `credentials: 'include'`.

| Action | Endpoint | Body |
|--------|----------|------|
| Request OTP | `POST /otp` | `{ email }` |
| Login | `POST /login` | `{ email, otp }` |
| Load lists | `POST /me` | `{ csrf }` |
| Open / sync list | `POST /list` | `{ csrf, name, list }` |

Opening a list sends `list: {}` to fetch the server-side state. Toggling an item or sweeping sends the full updated `list` map to merge.

## List Item Shape

```json
{
  "display": "Broccoli",
  "crossed": false,
  "deleted": false,
  "updated": 1746000000
}
```

- **crossed** — toggled by pressing Enter/Check on an item; shown with strikethrough
- **deleted** — set to `true` by Sweep on all crossed items; deleted items are excluded from the rendered list
- **updated** — Unix timestamp (seconds); server uses last-write-wins merge on this field

## Deploying

The frontend is a static bundle — copy the contents of this directory to the web root of `lists.elliscode.com`. The API and frontend share the same origin, so the HttpOnly session cookie is sent automatically.

Before deploying to KaiStore, add the two icon files:

- `icons/kaios_56.png` — 56×56 px
- `icons/kaios_112.png` — 112×112 px
