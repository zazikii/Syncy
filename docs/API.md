# Syncy API

Base path: `/v1`. All request and response bodies are JSON unless noted. Content blobs are uploaded and downloaded as raw bytes.

This API is for the separate Obsidian companion plugin. It is not compatible with Obsidian's official Sync protocol.

## Conventions

- Timestamps are Unix milliseconds.
- IDs are UUID strings unless a client supplies one. File IDs must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- SHA-256 hashes are lowercase 64-character hex.
- Protected endpoints require `Authorization: Bearer <accessToken>`.
- Errors use `{ "error": { "code": "...", "message": "...", "details": ... } }`.
- Unknown JSON fields in request bodies are rejected with `400 VALIDATION_ERROR`.

## Discovery and health

### `GET /healthz`

```json
{ "ok": true }
```

### `GET /readyz`

Returns `200 { "ok": true }` when the database is reachable, otherwise `503`.

### `GET /v1/info`

```json
{
  "name": "syncy",
  "version": "0.1.0",
  "setupRequired": false,
  "registrationOpen": false,
  "e2ee": true,
  "maxBlobBytes": 536870912,
  "realtime": true,
  "apiVersion": 1
}
```

`setupRequired` is true only when the database has no users and no `.env` user was configured.

## Authentication

### Device object

Many auth calls accept an optional `device`:

```json
{
  "id": "a-client-generated-id",
  "name": "Moritz's laptop",
  "platform": "windows"
}
```

`id` is optional. If omitted, the server generates one. Reusing another account's device ID is rejected.

### Session object

```json
{
  "tokenType": "Bearer",
  "accessToken": "eyJ...",
  "accessTokenExpiresAt": 1760000000000,
  "expiresIn": 900,
  "refreshToken": "opaque-refresh-token",
  "refreshTokenExpiresAt": 1762000000000,
  "deviceId": "device-id",
  "user": {
    "id": "user-id",
    "email": "you@example.com",
    "displayName": "You",
    "isAdmin": true,
    "disabled": false,
    "createdAt": 1750000000000,
    "updatedAt": 1750000000000
  }
}
```

Access tokens are short-lived. Refresh tokens are rotated on every use. Reusing an already-used refresh token revokes that entire token family.

### `POST /v1/setup`

First-run administrator creation. Allowed only while no users exist. If `SETUP_TOKEN` is configured, send it in the body or as `X-Setup-Token`.

```json
{
  "email": "you@example.com",
  "password": "at-least-10-characters",
  "name": "Optional name",
  "setupToken": "optional",
  "device": { "name": "Laptop" }
}
```

Returns `201` with a Session.

### `POST /v1/auth/register`

Requires `ALLOW_REGISTRATION=true` and an existing administrator. Body:

```json
{ "email": "...", "password": "...", "name": "...", "device": { ... } }
```

Returns `201` with a Session.

### `POST /v1/auth/login`

```json
{ "email": "you@example.com", "password": "...", "device": { ... } }
```

Returns `200` with a Session. Error codes: `INVALID_CREDENTIALS` (401), `ACCOUNT_DISABLED` (403).

### `POST /v1/auth/refresh`

```json
{ "refreshToken": "..." }
```

Returns a new access token and a new refresh token. The old refresh token is immediately invalid. If a revoked token is reused, its family is revoked and the request fails with `REFRESH_TOKEN_REUSED`.

### `POST /v1/auth/logout`

```json
{ "refreshToken": "..." }
```

Returns `204`.

### `POST /v1/auth/logout-all`

Protected. Revokes all refresh tokens and invalidates existing access tokens for the current user. Returns `204`. All devices need to log in again.

### `GET /v1/auth/me`

Protected.

```json
{
  "user": { ... },
  "deviceId": "current-device-id"
}
```

### `PATCH /v1/auth/me`

Protected.

```json
{ "displayName": "New name" }
```

`displayName` may be `null`.

### `POST /v1/auth/password`

Protected.

```json
{ "currentPassword": "...", "newPassword": "at-least-10-characters" }
```

Returns `204` and revokes all sessions, including existing access tokens. All devices need to log in again.

### `POST /v1/auth/ws-ticket`

Protected. Creates a single-use WebSocket ticket valid for 60 seconds.

```json
{ "ticket": "...", "expiresAt": 1750000060000 }
```

## Devices

### `GET /v1/devices`

```json
{
  "currentDeviceId": "device-id",
  "devices": [
    {
      "id": "device-id",
      "name": "Laptop",
      "platform": "windows",
      "createdAt": 1750000000000,
      "lastSeenAt": 1750000000000
    }
  ]
}
```

### `PATCH /v1/devices/:deviceId`

```json
{ "name": "Renamed device" }
```

### `DELETE /v1/devices/:deviceId`

Returns `204`. Deleting the current device also invalidates its access token on the next request.

## Vaults

### Vault object

```json
{
  "id": "vault-id",
  "name": "My vault",
  "e2ee": false,
  "revision": 42,
  "prunedBeforeRevision": 0,
  "role": "owner",
  "ownerId": "user-id",
  "keyEnvelope": null,
  "memberCount": 1,
  "createdAt": 1750000000000,
  "updatedAt": 1750000000000
}
```

`role` is `owner`, `editor` or `reader`. `keyEnvelope` is only returned for the requesting user's own membership (or to the owner via the members API). `revision` is the current vault cursor.

### `POST /v1/vaults`

```json
{
  "id": "optional-client-supplied-id",
  "name": "My vault",
  "e2ee": false,
  "keyEnvelope": "optional-opaque-wrapped-key"
}
```

Returns `201 { "vault": ... }`.

### `GET /v1/vaults`

```json
{ "vaults": [ ... ] }
```

### `GET /v1/vaults/:vaultId`

Returns `{ "vault": ... }`. Non-members receive `404`.

### `PATCH /v1/vaults/:vaultId`

Owner only.

```json
{ "name": "Renamed vault" }
```

### `DELETE /v1/vaults/:vaultId`

Owner only. Permanently deletes the vault, its files, history and memberships. Blobs become eligible for garbage collection. Returns `204`.

## Vault members

### `GET /v1/vaults/:vaultId/members`

```json
{
  "members": [
    {
      "userId": "user-id",
      "email": "you@example.com",
      "displayName": "You",
      "role": "owner",
      "hasKeyEnvelope": true,
      "keyEnvelope": "...",
      "createdAt": 1750000000000
    }
  ]
}
```

`keyEnvelope` is omitted unless you are the owner or the member themselves.

### `POST /v1/vaults/:vaultId/members`

Owner only. The target account must already exist.

```json
{
  "email": "friend@example.com",
  "role": "editor",
  "keyEnvelope": "opaque-wrapped-vault-key"
}
```

`role` is `editor` or `reader`. Returns `201 { "member": ... }`.

### `PATCH /v1/vaults/:vaultId/members/:userId`

```json
{ "role": "reader", "keyEnvelope": null }
```

Only the owner can change roles. A member may update their own key envelope. The owner role cannot be changed.

### `DELETE /v1/vaults/:vaultId/members/:userId`

The owner can remove others. A non-owner can remove themselves. The owner cannot leave; transfer or delete the vault instead. Returns `204` and immediately unsubscribes the member from live events.

## Files and snapshots

### `GET /v1/vaults/:vaultId/files`

Query: `includeDeleted=true|false` (default `false`).

```json
{
  "vaultId": "vault-id",
  "revision": 42,
  "prunedBeforeRevision": 0,
  "files": [
    {
      "fileId": "stable-file-id",
      "path": "Notes/Hello.md",
      "kind": "file",
      "encrypted": false,
      "hash": "sha256-of-content",
      "size": 1234,
      "mtime": 1750000000000,
      "ctime": 1750000000000,
      "revision": 41,
      "deleted": false,
      "updatedAt": 1750000000000
    }
  ]
}
```

This is an unpaginated point-in-time snapshot. Use it for a full resync after `CURSOR_EXPIRED`, then pull changes since the returned `revision`.

For E2EE vaults, `path` is opaque ciphertext and `encrypted` is true.

## Change feed

### `GET /v1/vaults/:vaultId/changes`

Query parameters:

| Parameter | Default | Description |
| --- | --- | --- |
| `since` | `0` | Return changes with `revision > since`. |
| `until` | current revision | Return changes with `revision <= until`. |
| `limit` | `500` | 1–2000 changes per page. |

```json
{
  "vaultId": "vault-id",
  "since": 10,
  "until": 42,
  "revision": 42,
  "prunedBeforeRevision": 0,
  "hasMore": false,
  "nextCursor": 42,
  "changes": [
    {
      "revision": 41,
      "fileId": "stable-file-id",
      "versionId": "version-id",
      "path": "Notes/Hello.md",
      "kind": "file",
      "encrypted": false,
      "hash": "sha256-of-content",
      "size": 1234,
      "mtime": 1750000000000,
      "ctime": 1750000000000,
      "deleted": false,
      "deviceId": "device-id",
      "createdAt": 1750000000000
    }
  ]
}
```

Changes are ordered ascending by revision. For deletions, `hash` is `null` and `path` is retained so clients know what disappeared.

Errors:

- `410 CURSOR_EXPIRED` — `since` is older than `prunedBeforeRevision`. Do a full snapshot.
- `410 CURSOR_AHEAD` — the server revision is behind the cursor (for example after restoring a backup). Do a full snapshot.

## Pushing changes

### `POST /v1/vaults/:vaultId/changes`

Requires the `editor` or `owner` role.

```json
{
  "atomic": true,
  "changes": [
    {
      "fileId": "stable-file-id",
      "path": "Notes/Hello.md",
      "kind": "file",
      "encrypted": false,
      "hash": "sha256-of-content",
      "size": 1234,
      "mtime": 1750000000000,
      "ctime": 1750000000000,
      "deleted": false,
      "expectedRevision": 40
    }
  ]
}
```

### Change input

| Field | Required | Description |
| --- | --- | --- |
| `fileId` | yes | Stable client-generated identity. Keep it across renames. |
| `path` | yes | Relative vault path. Normalized to NFC and `/` separators. For E2EE it is opaque ciphertext. |
| `kind` | yes | `file` or `folder`. |
| `encrypted` | no | Must match the vault mode. Defaults to the vault mode. |
| `hash` | files | SHA-256 of the blob content (ciphertext for E2EE). Required unless deleting or folder. |
| `size` | no | Ignored. The server uses the stored blob's actual size. |
| `mtime` / `ctime` | no | Client timestamps in milliseconds. |
| `deleted` | no | `true` creates a tombstone. |
| `expectedRevision` | strongly recommended | See below. |

### `expectedRevision`

- **number** — the last known revision of this file. The server rejects the change if the file's current revision differs.
- **null** — "I expect no live file with this ID." Used for creation. Resurrecting a deleted file is allowed; taking over a live file ID is not.
- **omitted** — unconditional. Avoid this in clients because it can overwrite newer changes.

Every accepted change gets a new vault revision and becomes the file's new revision.

### Batch semantics

- `atomic: true` (default): if any change conflicts, nothing is applied and the response is `409`.
- `atomic: false`: conflict-free changes are applied; conflicting changes are returned in `conflicts`.
- Duplicate `fileId`s in one batch are rejected.
- Rename chains and path swaps are supported when all involved changes are in the same atomic batch.
- A file change with a blob hash requires the blob to exist. Upload blobs first.

### Response

```json
{
  "vaultId": "vault-id",
  "previousRevision": 42,
  "revision": 44,
  "applied": true,
  "hasConflicts": false,
  "results": [
    {
      "fileId": "stable-file-id",
      "status": "applied",
      "revision": 43,
      "versionId": "version-id"
    }
  ],
  "conflicts": []
}
```

Result statuses:

- `applied` — committed.
- `conflict` — see `conflict`.
- `skipped` — for example deleting a file that was already deleted.
- `rejected` — valid on its own, but rolled back because another change in the atomic batch conflicted.

Conflict object:

```json
{
  "fileId": "stable-file-id",
  "code": "revision_mismatch",
  "message": "The file has changed on the server since the expected revision",
  "server": {
    "fileId": "stable-file-id",
    "path": "Notes/Hello.md",
    "kind": "file",
    "encrypted": false,
    "hash": "...",
    "size": 1234,
    "mtime": 0,
    "ctime": 0,
    "revision": 43,
    "deleted": false,
    "updatedAt": 1750000000000
  }
}
```

Conflict codes: `revision_mismatch`, `not_found`, `already_exists`, `path_taken`.

### Resolving conflicts

1. Pull changes since your cursor and update local metadata.
2. If the server content is newer, either:
   - keep both by creating a conflict copy (new `fileId`, new path such as `Note (conflict 2026-10-25).md`) and pushing that, or
   - overwrite deliberately by pushing with `expectedRevision` equal to the server revision.
3. Re-push remaining changes.

## Blobs

Blobs are content-addressed. The hash is calculated by the client over the exact bytes to upload (ciphertext for E2EE). Uploading the same bytes again is idempotent.

### `PUT /v1/vaults/:vaultId/blobs/:sha256`

- Requires `editor` or `owner`.
- `Content-Type: application/octet-stream`.
- Body: raw bytes.
- Maximum: `MAX_BLOB_BYTES`.

Returns `201` for a new blob or `200` for an existing one:

```json
{ "hash": "...", "size": 1234, "deduped": false }
```

The server verifies the SHA-256 while streaming. A mismatch returns `400 BLOB_HASH_MISMATCH`.

### `HEAD /v1/vaults/:vaultId/blobs/:sha256`

Returns `200` if the blob exists globally, otherwise `404`. The response includes `X-Syncy-Blob-Exists: true|false`.

### `GET /v1/vaults/:vaultId/blobs/:sha256`

- Requires at least `reader`.
- Serves the blob only if at least one version in this vault references the hash.
- Supports single byte ranges (`Range: bytes=start-end`, `bytes=start-`, `bytes=-suffix`).
- Returns `206` for ranges, `416` for invalid ranges, `304` for a matching `If-None-Match` ETag.
- `Cache-Control: private, max-age=31536000, immutable`.

## Version history

### `GET /v1/vaults/:vaultId/files/:fileId/versions`

Query: `cursor` (revision, exclusive) and `limit` (1–200, default 50). Results are newest first and exclude delete tombstones.

```json
{
  "vaultId": "vault-id",
  "fileId": "stable-file-id",
  "hasMore": false,
  "nextCursor": null,
  "versions": [
    {
      "id": "version-id",
      "fileId": "stable-file-id",
      "revision": 41,
      "path": "Notes/Hello.md",
      "kind": "file",
      "encrypted": false,
      "hash": "...",
      "size": 1234,
      "mtime": 0,
      "ctime": 0,
      "deleted": false,
      "deviceId": "device-id",
      "createdAt": 1750000000000
    }
  ]
}
```

Fetch the content through the blob endpoint using `version.hash`.

### `GET /v1/vaults/:vaultId/files/:fileId/versions/:versionId`

Returns `{ "version": ... }`.

### `POST /v1/vaults/:vaultId/files/:fileId/versions/:versionId/restore`

Requires `editor` or `owner`.

```json
{
  "expectedRevision": 44,
  "path": "Optional/new-path.md"
}
```

Restores the version's content (and kind) as a new change. If the file is live, the current path is kept unless `path` is supplied. If the file is deleted, the version's path is used unless overridden. Returns the same response shape as a change push; a path collision returns `409`.

## Admin

All admin endpoints require an administrator access token.

### `GET /v1/admin/stats`

```json
{
  "server": { "name": "syncy", "version": "0.1.0" },
  "users": 2,
  "vaults": 3,
  "devices": 4,
  "blobs": 120,
  "storageBytes": 12345678,
  "connectedSockets": 1
}
```

### `GET /v1/admin/users`

Query: `limit` (1–200, default 50), `offset`, `search`.

```json
{
  "users": [ ... ],
  "total": 2,
  "limit": 50,
  "offset": 0
}
```

### `PATCH /v1/admin/users/:userId`

```json
{ "isAdmin": true, "disabled": false }
```

You cannot disable or demote yourself, and the last active administrator cannot be removed. Disabling a user drops their WebSocket connections and invalidates their access tokens immediately. Re-enabling does not restore old tokens.

## WebSocket

1. Call `POST /v1/auth/ws-ticket`.
2. Connect to `wss://host/v1/ws?ticket=<ticket>`. Tickets are single-use and expire after 60 seconds.

Server hello:

```json
{
  "type": "hello",
  "userId": "user-id",
  "deviceId": "device-id",
  "serverVersion": "0.1.0",
  "serverTime": 1750000000000
}
```

Client messages:

```json
{ "type": "subscribe", "vaultId": "vault-id" }
{ "type": "unsubscribe", "vaultId": "vault-id" }
{ "type": "ping" }
```

Server messages:

```json
{ "type": "subscribed", "vaultId": "vault-id", "revision": 42 }
{ "type": "unsubscribed", "vaultId": "vault-id" }
{ "type": "unsubscribed", "vaultId": "vault-id", "reason": "membership_changed" }
{ "type": "pong", "serverTime": 1750000000000 }
{ "type": "vault_updated", "vaultId": "vault-id", "name": "New name", "actorUserId": "user-id" }
{
  "type": "vault_changed",
  "vaultId": "vault-id",
  "revision": 43,
  "actorUserId": "user-id",
  "originDeviceId": "device-id"
}
{ "type": "vault_members_changed", "vaultId": "vault-id", "actorUserId": "user-id" }
{ "type": "vault_deleted", "vaultId": "vault-id", "actorUserId": "user-id" }
{
  "type": "error",
  "code": "VAULT_NOT_FOUND",
  "message": "Vault not found",
  "vaultId": "vault-id"
}
```

The WebSocket is a notification channel only. After `vault_changed`, pull the change feed from your cursor. Ignore notifications where `originDeviceId` is your own device if you already applied the change locally. The server sends ping frames every 30 seconds.

## End-to-end encrypted vaults

When a vault is created with `e2ee: true`:

- Every change must set `encrypted: true`.
- `path` is client-encrypted ciphertext. The server stores it verbatim and does not enforce path uniqueness.
- `hash` is the SHA-256 of the ciphertext blob.
- File identity is entirely `fileId`-based. Keep it stable across renames.
- Version history stores ciphertext and opaque paths. The plugin decrypts versions.
- The server cannot merge or detect filename conflicts. The plugin resolves them.
- The owner distributes a wrapped vault key to each member through `keyEnvelope` on the member object.

See [E2EE.md](E2EE.md).

## Complete sync example

```bash
# 1. Authenticate
TOKEN=$(curl -s http://localhost:8080/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"...","device":{"name":"Laptop"}}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')

# 2. Create a vault
VAULT=$(curl -s http://localhost:8080/v1/vaults \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"My vault"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).vault.id')

# 3. Upload a blob
HASH=$(printf 'hello' | sha256sum | cut -d' ' -f1)
printf 'hello' | curl -s -X PUT \
  "http://localhost:8080/v1/vaults/$VAULT/blobs/$HASH" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/octet-stream' \
  --data-binary @-

# 4. Push the file change
curl -s http://localhost:8080/v1/vaults/$VAULT/changes \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"changes":[{"fileId":"note-hello","path":"Hello.md","kind":"file","hash":"'$HASH'","expectedRevision":null}]}'

# 5. Pull changes
curl -s "http://localhost:8080/v1/vaults/$VAULT/changes?since=0" \
  -H "authorization: Bearer $TOKEN"
```

## Status codes

| Status | Meaning |
| --- | --- |
| `200` | Success. |
| `201` | Created. |
| `204` | Success with no body. |
| `206` | Partial blob content. |
| `304` | Blob ETag matched. |
| `400` | Invalid input, missing blob, bad path, encryption mismatch. |
| `401` | Missing/invalid/expired token, invalid credentials, revoked device. |
| `403` | Insufficient role, setup complete, registration disabled, account disabled. |
| `404` | Resource not found or not visible to this user. |
| `409` | Revision/path conflict or duplicate setup/resource. |
| `410` | Sync cursor expired or ahead; full resync required. |
| `413` | Blob or JSON body too large. |
| `416` | Invalid byte range. |
| `429` | Rate limited. |
| `500` | Internal error. |

Common error codes include `VALIDATION_ERROR`, `UNAUTHORIZED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `REFRESH_TOKEN_REUSED`, `INVALID_CREDENTIALS`, `ACCOUNT_DISABLED`, `DEVICE_REVOKED`, `INSUFFICIENT_ROLE`, `VAULT_NOT_FOUND`, `BLOB_MISSING`, `BLOB_HASH_MISMATCH`, `BLOB_TOO_LARGE`, `INVALID_PATH`, `ENCRYPTION_MISMATCH`, `DUPLICATE_FILE_ID`, `CURSOR_EXPIRED`, `CURSOR_AHEAD`, `RATE_LIMITED`.

