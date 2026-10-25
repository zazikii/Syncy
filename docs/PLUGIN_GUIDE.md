# Companion plugin implementation guide

This document describes how the separate Obsidian plugin should use the Syncy server. The server is content-agnostic: notes, attachments, themes, plugins and settings all follow the same file protocol.

## 1. Local sync state

Keep sync state outside the synced vault tree, for example in the plugin's `data.json`, IndexedDB or another local store. Never sync cursors, pending queues or file-ID maps back to the server.

Recommended state per vault:

```ts
interface VaultState {
  remoteVaultId: string;
  cursor: number;
  fileIds: Record<string, string>;      // normalized local path -> stable fileId
  paths: Record<string, string>;        // fileId -> normalized local path
  revisions: Record<string, number>;    // fileId -> last applied server revision
  hashes: Record<string, string>;       // fileId -> last known content hash
  pending: Array<{ fileId: string; ... }>;
}
```

If the plugin's own folder lives inside the vault (for example `.obsidian/plugins/syncy/`), exclude that folder from sync or store state elsewhere.

## 2. Stable file IDs

The server identifies files by `fileId`, not by path. Renames keep the same `fileId`; that is how version history and conflict detection survive moves.

### Plaintext vaults

1. Assign a UUID when a file is first seen locally.
2. Persist the mapping.
3. On first connection to an existing remote vault, pull the snapshot before pushing. Adopt the server's `fileId` for matching paths.
4. If a push returns `409 path_taken` with a server file at the same path:
   - If the content hash matches, adopt the server `fileId` and retry with that ID.
   - If the content differs, create a conflict copy with a new `fileId` and a new path, then push both.
5. Never derive a new ID solely from a path after the initial assignment.

### E2EE vaults

The server cannot see paths or detect collisions, so devices that seed the same existing vault independently must derive the same IDs. A good strategy:

```
fileId = base32(HMAC-SHA256(vaultKey, "syncy-file-id:" + NFC(normalizedPlaintextPath))).slice(0, 32)
```

Use this deterministic ID when importing existing files. New files created after initial sync get random UUIDs. Keep the ID stable on rename.

If two devices have already diverged before the first sync, compare content and resolve conflicts client-side.

## 3. Hashing and uploading

The blob hash is the SHA-256 of the exact bytes uploaded:

- Plaintext vault: hash the file bytes.
- E2EE vault: encrypt first, then hash the ciphertext.

Flow for every create or update:

1. Read the file and compute `hash`.
2. If this hash was already uploaded for this vault, skip the upload.
3. `PUT /v1/vaults/:id/blobs/:hash` with `Content-Type: application/octet-stream`.
4. Push a change referencing the hash.

Uploading the same blob twice is safe and returns `200` with `deduped: true`. The server verifies the hash while streaming. Do not upload zero-byte files unless the hash matches empty content (`e3b0c442...`); empty files are valid.

For large files, use a streaming PUT and report progress. The server stores blobs content-addressed and deduplicates them across files and versions.

## 4. Pushing local changes

Debounce the Obsidian file watcher (200–500 ms) and coalesce rapid saves. Only push when the content hash or metadata actually changed.

```json
{
  "atomic": true,
  "changes": [
    {
      "fileId": "stable-id",
      "path": "Notes/Hello.md",
      "kind": "file",
      "hash": "sha256",
      "mtime": 1760000000000,
      "ctime": 1750000000000,
      "expectedRevision": 42
    }
  ]
}
```

Rules:

- Use `expectedRevision: null` for a new file.
- Use the last applied server revision for updates and deletes.
- Batch a rename with any related moves in one atomic request. Path swaps and chains are supported.
- For folders, omit `hash` and use `kind: "folder"`.
- For deletes, send `deleted: true` and the last known `expectedRevision`.
- Do not set `size`; the server uses the stored blob size.
- If a batch returns `409`, pull changes, resolve, and retry. With `atomic: false`, apply the successful subset and handle the `conflicts` array.

### Conflict copies

The plugin owns conflict UX. A simple, Obsidian-like policy:

1. Pull the server change for the conflicting file.
2. If local content differs, create a new file with a new `fileId` and a path such as:
   - `Note (conflict 2026-10-25 143512).md`
   - Keep the extension and preserve the directory.
3. Push the conflict copy.
4. Update the original file to the server state.
5. Optionally offer "keep local" which pushes with the server's current `expectedRevision`.

Never silently overwrite a newer server revision.

## 5. Pulling remote changes

### Normal incremental pull

```
GET /v1/vaults/:id/changes?since=<cursor>&until=<revision>&limit=500
```

1. Read the current vault revision (from the vault object or a previous response).
2. Fix `until` to that revision for the whole pull cycle.
3. Page until `hasMore` is false.
4. Apply each change in revision order.
5. Set `cursor = until` only after the whole page cycle is applied.
6. Repeat if the vault revision advanced during the pull.

Apply changes idempotently. If the plugin crashes, re-pulling from the old cursor must be safe.

For each change:

- `deleted: true` — remove the local path for that `fileId` (if it still belongs to that ID). Do not remove a file at that path that belongs to a different `fileId`.
- `kind: "folder"` — create the folder.
- `kind: "file"` — download `hash` if not present locally, verify the SHA-256, decrypt if E2EE, write to a temp file and atomically rename, then set `mtime`.
- Path changed (same `fileId`, new path) — move the local file from the old path to the new one.
- Use `revisions[fileId]` to ignore already-applied changes.

### Full resync

Trigger when:

- The changes endpoint returns `410 CURSOR_EXPIRED` or `410 CURSOR_AHEAD`.
- The local mapping or cache is missing.
- The user requests a repair.

Procedure:

1. `GET /v1/vaults/:id/files?includeDeleted=true` and record its `revision`.
2. Reconcile local files against the snapshot:
   - Server live file and local file exists: compare hashes; download if needed.
   - Server live file missing locally: download.
   - Server tombstone or absent: remove the local file **only if** it is managed by Syncy and is not excluded by selective sync.
3. Set the cursor to the snapshot revision.
4. Pull changes since that revision.

Be conservative when deleting local files: a full resync should not delete excluded paths, plugin state or files the user added while offline.

## 6. Real-time notifications

1. `POST /v1/auth/ws-ticket` to get a single-use ticket.
2. Connect to `wss://<host>/v1/ws?ticket=<ticket>`.
3. Wait for `hello`.
4. Send `{"type":"subscribe","vaultId":"..."}` for each vault.
5. On `vault_changed`, pull changes. Ignore events whose `originDeviceId` matches your device when you already applied them.
6. On `unsubscribed` with `reason: "membership_changed"`, stop syncing that vault.
7. On `vault_deleted`, stop and notify the user.
8. Reconnect with exponential backoff. Re-subscribe and pull after every reconnect, because notifications are not a durable log.
9. Send an application-level `ping` periodically if the underlying connection is idle.

The WebSocket is only a hint. The change feed is the source of truth.

## 7. Selective sync

Syncy does not impose filters. The plugin decides what to push and pull. A good classification:

### Notes and attachments

- Include: all regular files under the vault except exclusions.
- Exclude by default: `.trash/**`, `.git/**`, OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`), temporary files, and the plugin's own state.

### Settings

- Include: `.obsidian/app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`, `community-plugins.json`, `themes.json`, `snippets/**`, `themes/**`.
- Optional per device: `workspace.json`, `workspace-mobile.json`, `graph.json` — these are often device-specific.

### Community plugins

- Include: `.obsidian/community-plugins.json` and `.obsidian/plugins/**`.
- Plugin `data.json` files may contain API keys and tokens. Sync them only when the user opts in, and prefer E2EE for vaults that contain such data.
- Plugin bundles (`main.js`) can be large; blob deduplication makes updates cheap.

When selective sync changes, do not delete remote data automatically. Only stop syncing the excluded paths locally.

## 8. End-to-end encryption

For an E2EE vault:

1. Generate a random 256-bit vault key on the first device.
2. Encrypt file content with an AEAD (XChaCha20-Poly1305 or AES-256-GCM). Use a fresh nonce per file version and store the nonce with the ciphertext (or in a client-side header inside the blob).
3. Encrypt paths with the vault key. `fileId` remains stable and is not encrypted.
4. Hash and upload ciphertext exactly as in plaintext mode.
5. Push changes with `encrypted: true`.

Key delivery:

- The server stores an opaque `keyEnvelope` per member. It does not know the vault key.
- Derive a **separate E2EE passphrase key** from a user passphrase, not from the login password, unless the plugin explicitly re-wraps keys on every password change.
- For a single user with multiple devices, derive a user key-encryption key from the E2EE passphrase with Argon2id and store the wrapped vault key in the owner's envelope. Each device fetches its envelope and asks for the passphrase.
- For sharing:
  - Option A: the owner unwraps the vault key and rewraps it for the new member using a public key (for example X25519) or a shared passphrase.
  - Option B: use a passphrase shared out of band and store a passphrase-wrapped envelope.
- After adding a member, `PATCH /v1/vaults/:id/members/:userId` with the new `keyEnvelope`.
- A new member with `hasKeyEnvelope: false` cannot decrypt the vault until the owner provides an envelope.

The server never validates that ciphertext is real. A compromised client can still push garbage; E2EE protects confidentiality, not integrity against malicious members.

## 9. Failure handling

| Situation | Recommended action |
| --- | --- |
| `401 TOKEN_EXPIRED` | Refresh once, retry the request. |
| `401 REFRESH_TOKEN_REUSED` | Stop, clear tokens and require login. |
| `401 DEVICE_REVOKED` | Require login on a new device. |
| `403 INSUFFICIENT_ROLE` | Stop pushing; switch to read-only behavior. |
| `409 revision_mismatch` | Pull, resolve, retry with the server revision or create a conflict copy. |
| `409 path_taken` | Adopt the server `fileId` if content matches, otherwise create a conflict copy. |
| `410 CURSOR_EXPIRED` / `CURSOR_AHEAD` | Full resync. |
| `413` | Blob too large; show the configured limit and fail the file cleanly. |
| `429` | Honor `Retry-After` (or back off exponentially). |
| Network failure | Keep pending changes, retry with jitter, never lose local data. |

## 10. Recommended sync loop

```
on local change:
  hash = sha256(file)
  if hash == state.hashes[fileId]: return
  upload blob if needed
  push change(expectedRevision = state.revisions[fileId] ?? null)
  on conflict: pull, resolve, retry
  state.revisions[fileId] = result.revision

on websocket notification or timer:
  pull changes since cursor
  apply idempotently
  cursor = until

on app start:
  refresh token if needed
  full snapshot if no cursor
  pull changes
  subscribe websocket
```

## 11. Excluding Syncy's own data

If the plugin stores state inside the vault, add a hard exclusion for:

```
.obsidian/plugins/syncy/**
.obsidian/syncy/**
```

Better: store state in the plugin's local data outside the synced file set. Syncing a cursor or a file-ID map can cause loops and divergence between devices.
