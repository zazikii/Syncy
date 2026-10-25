# Architecture

Syncy is a single-process HTTP and WebSocket server backed by SQLite and a local content-addressed blob store. It is deliberately small enough to run on a personal VPS.

## Components

```
src/
├── index.ts                entrypoint: config, listen, graceful shutdown
├── app.ts                  Fastify assembly, decorators, lifecycle
├── config.ts               environment parsing, single-user config, secrets
├── errors.ts               AppError and uniform error responses
├── auth/                   password hashing, JWT, refresh tokens, tickets
├── db/                     SQLite schema and typed access helpers
├── routes/                 HTTP and WebSocket endpoints
├── services/               sync engine, blob store, garbage collection
├── utils/                  paths, hashes, IDs, constant-time comparison
└── ws/                     in-memory WebSocket subscription hub
```

At runtime:

- **Fastify** serves `/v1`.
- **better-sqlite3** holds all metadata in WAL mode.
- **LocalBlobStore** stores bytes at `DATA_DIR/blobs/<ab>/<cd>/<sha256>`.
- **WsHub** tracks connected sockets and their vault subscriptions in memory.
- **WsTicketStore** issues single-use WebSocket tickets; tickets are process-local.

The process is intended to be the only writer to its data directory.

## Data model

### users

Account identity, scrypt password hash, admin/disabled flags, and `token_version`.

`token_version` is embedded in access tokens and checked on every protected request. Password changes, `logout-all`, account disable, and configured-user password rotation increment it, invalidating all existing access tokens immediately.

### devices

A device belongs to one user. Access tokens are bound to a device ID. Refresh tokens are associated with a device. Deleting a device invalidates its tokens and live socket on the next check.

### refresh_tokens

Opaque 256-bit tokens stored only as SHA-256 hashes.

- A token family starts at login.
- Every refresh rotates the token in the same family.
- Reuse of a revoked token revokes the whole family.
- Tokens are pruned after expiry/revocation.

### vaults

A vault has an owner, name, E2EE flag, monotonically increasing `revision`, and `pruned_before_rev` for change-log garbage collection.

### vault_members

(`vault_id`, `user_id`) with role `owner`, `editor` or `reader` and an optional opaque `key_envelope` for E2EE.

Authorization is checked on every request. The role is never cached in the access token, so demotions take effect immediately. Removing a member also unsubscribes their live socket.

### files

One row per (`vault_id`, `file_id`). It stores the current state:

- normalized `path` and `path_key` (plaintext vaults)
- opaque `path` (E2EE vaults)
- kind (`file`/`folder`)
- encryption flag
- current blob hash and size
- client mtime/ctime
- current server revision
- tombstone flag
- last writer device

Rows are never deleted per file; deletes become tombstones. This keeps file IDs reserved and makes resurrection and conflict detection deterministic.

A partial unique index enforces live path uniqueness for plaintext vaults:

```sql
CREATE UNIQUE INDEX files_live_path_unique
ON files(vault_id, path_key)
WHERE deleted = 0 AND encrypted = 0 AND path_key IS NOT NULL;
```

E2EE vaults deliberately skip path uniqueness: the server cannot see paths.

### versions

Every accepted change writes an immutable version snapshot: path, kind, encryption, hash, size, timestamps, deletion flag, device and revision. Version content is the blob with `hash`.

Version history queries exclude delete tombstones, so users only see content versions. Restoring copies a version's metadata into a new change.

### changes

An ordered append-only log per vault: `(vault_id, revision) -> version_id`. It is the sync cursor source. Pull queries join versions for metadata.

Revisions are assigned per accepted change inside a transaction. A batch of N accepted changes advances the vault revision by N. If a batch is rejected, no revisions are consumed.

## Authentication and request lifecycle

1. A route pre-handler calls `authenticate`.
2. The bearer token is verified with HS256 using the server secret.
3. The user is loaded from SQLite and checked for existence, disabled state, token version and device revocation.
4. `request.auth` is populated.
5. The route parses input with Zod, checks vault role, and executes.
6. Errors become uniform `{ error: { code, message, details } }` responses.

Access tokens are short-lived. Refresh tokens are long-lived, opaque and rotated. WebSocket clients exchange an access token for a single-use ticket before upgrading.

## Sync engine

`services/sync.ts` implements the core algorithm.

### Validation

For each change in a batch:

1. Reject duplicate file IDs.
2. Verify referenced blobs exist and record their actual sizes.
3. Inside a synchronous SQLite transaction, compare `expectedRevision` with the current file row.
4. Normalize the path or accept an opaque encrypted path.
5. Validate folder/file rules and encryption mode.

`expectedRevision` semantics:

- `number` — optimistic concurrency check.
- `null` — require no live file at that ID.
- omitted — unconditional (discouraged).

### Path conflict detection

For plaintext vaults, the engine simulates the final live path map for the batch:

- Start from all currently live plaintext files.
- Apply the batch changes in input order, but iterate until no new conflicts appear because rejecting one change makes its old path remain occupied.
- Unchanged files win over changes.
- If multiple changes target the same free path, the earliest input order wins; the rest conflict.

This permits atomic rename chains and path swaps while keeping the final state unique. The database unique index is a second line of defense.

### Apply

If the batch is atomic and any conflict exists, no writes occur and the response is `409`.

Otherwise:

1. Temporarily clear `path_key` for all accepted existing rows, so renames and swaps cannot violate the unique index mid-transaction.
2. For each accepted change, assign the next revision, upsert the file row, insert a version and insert a change-log entry.
3. Update the vault revision and timestamp.
4. Commit.
5. Broadcast a `vault_changed` notification after commit.
6. Return per-change results and conflicts.

### Pull

`GET /changes` reads a bounded range `(since, until]`, joins version metadata, and paginates. Clients fix `until` for a pull cycle to avoid a moving target.

- `since < prunedBeforeRevision` → `410 CURSOR_EXPIRED`.
- `since > currentRevision` → `410 CURSOR_AHEAD` (for example after a backup restore).

A full snapshot is available from `GET /files`.

## Blob storage

Blobs are immutable and content-addressed:

- Clients send a SHA-256 in the URL.
- The server streams the body through a hash and size meter into a temp file.
- On hash mismatch, the temp file is discarded.
- On success, the temp file is renamed into its sharded path.
- Existing hashes are drained and returned as deduplicated.

Downloads are authorized by checking that at least one version in the requested vault references the hash. Ranges and ETags are supported.

Garbage collection deletes blobs older than a grace period that are not referenced by any file or retained version.

## Versioning and retention

Every change is a version. The latest version per file is always retained, because it represents current state and keeps current blobs referenced.

`services/gc.ts`:

1. Selects non-latest versions older than the retention window.
2. Deletes them and the changes up to the highest deleted revision per vault.
3. Advances `pruned_before_rev`.
4. Computes referenced hashes after pruning.
5. Deletes unreferenced blobs older than the grace window.

Pruning forces clients on older cursors to do a full snapshot. This is the intended trade-off for bounded storage.

## Real-time layer

- `POST /auth/ws-ticket` creates a random, single-use, 60-second ticket.
- `/v1/ws` consumes it and checks account/device state.
- Clients subscribe to vaults; membership is checked at subscription time.
- Events are hints: `vault_changed` carries the new revision, but clients pull the durable change feed.
- The hub tracks liveness with ping/pong every 30 seconds.
- Account disable, password rotation, logout-all and member removal close/drop affected sockets.

Tickets and sockets are in memory, which is one reason the server is single-instance.

## End-to-end encryption boundary

The server never handles vault keys. It stores:

- ciphertext blobs and their SHA-256 hashes
- opaque encrypted paths
- opaque per-member key envelopes
- all metadata listed in [E2EE.md](E2EE.md)

Because path uniqueness is not enforced for E2EE vaults, clients must resolve path conflicts. Stable file IDs are the only server-visible identity.

## Single-instance design

Supported:

- One process per data directory
- SQLite WAL for concurrent readers and a single writer
- In-memory WebSocket hub and tickets

Not supported:

- Multiple replicas sharing one SQLite file or data directory
- Horizontal scaling with sticky sessions
- Multi-node WebSocket fan-out
- Object storage backends

To scale beyond one node, the natural evolution is Postgres for metadata, an S3-compatible blob store, and a pub/sub layer for WebSocket events. The current interfaces are small enough to make that migration feasible.

## Failure behavior

- SQLite write failures roll back the whole batch.
- Blob upload failures leave no referenced metadata.
- A crash between blob upload and change push leaves an orphan blob, collected later.
- A crash during pull is safe: changes are applied idempotently and the cursor advances only after a complete pull cycle.
- A crash before the WebSocket broadcast is harmless: clients also poll or pull on reconnect.
- Backups restore metadata and blobs; clients behind the restored revision receive `CURSOR_AHEAD` and resync.
