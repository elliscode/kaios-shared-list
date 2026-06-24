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

## Auth flow

1. `POST /otp` — client submits email, server sends a 6-digit OTP via SES
2. `POST /login` — client submits email + OTP, server returns session cookie + `x-csrf-token` header
3. Authenticated routes — require session cookie + `csrf` field in request body

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
