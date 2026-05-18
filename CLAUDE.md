# kaios-shared-list

A shared list app backend running on AWS Lambda, fronted by API Gateway.

## Architecture

```
DNS (lists.elliscode.com) → API Gateway → Lambda → DynamoDB
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
openapi.yaml                    # API spec — keep in sync (see rule below)
```

## Rules

**Whenever you add, remove, or change a route in `backend/lambda/lambda_function.py`, update `openapi.yaml` at the project root to match.**

This includes: new paths, changed request bodies, changed response shapes, new status codes, auth requirement changes.

## Deploying

```bash
# Dev
sh backend/dev-release.sh

# Prod
sh backend/prod-release.sh
```

## Frontend (planned)

The frontend will live in a `frontend/` directory at the repo root. It will be a single HTML/CSS/JS codebase that works in two modes:

- **KaiOS app** — 240px-wide screen, D-pad/key navigation, `manifest.json` for installability
- **Web browser** — responsive layout, touch-capable, same functionality

No framework is decided yet. The backend is being completed first.

## Auth flow

1. `POST /otp` — client submits email, server sends a 6-digit OTP via SES (not yet wired in router)
2. `POST /login` — client submits email + OTP, server returns session cookie + `x-csrf-token` header (not yet wired in router)
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
