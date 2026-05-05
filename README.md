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

## Frontend

TODO