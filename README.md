# KaiOS Shared List

This app allows you to share a grocery list from your KaiOS device to anyone with a computer, laptop, smartphone, or KaiOS device. It uses WebSockets for live list updates to allow two poeple to edit at once.

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

TODO