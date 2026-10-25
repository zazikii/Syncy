# Syncy

Self-hosted sync server for Obsidian vaults. Syncy syncs everything a vault contains: notes, attachments, `.obsidian` settings, plugins, plugin data, themes, snippets and any other files your companion plugin chooses to include.

Syncy is the server side only. The Obsidian plugin is being built separately. This server implements a clean HTTP/WebSocket protocol for that plugin; it does **not** speak Obsidian's proprietary, undocumented Sync protocol.

## Features

- **Full vault sync** — notes, attachments, folders, plugin bundles, `data.json`, themes, snippets and config files are all content-agnostic and sync byte-for-byte.
- **Incremental sync** — revision-based change feed with per-file optimistic concurrency, tombstones, renames and atomic multi-file batches.
- **Conflict detection** — revision and path conflicts are reported to the client instead of silently overwriting data.
- **Version history** — every accepted change is versioned, with restore support and downloadable historical content.
- **Optional end-to-end encryption** — encrypted vaults store only opaque paths and ciphertext blobs; per-member key envelopes enable sharing.
- **Sharing** — owner / editor / reader roles per vault, with live removal of revoked members.
- **Real-time sync** — WebSocket notifications wake clients immediately; clients then pull the change feed.
- **Multi-device** — device registration, refresh-token rotation, device revocation and reuse detection.
- **Single-user friendly** — configure one account in `.env`; Syncy creates it on first start and keeps the password in sync on later starts.
- **Self-hosting ready** — Docker Compose, SQLite, content-addressed local blob storage, health checks, admin API and CLI tooling.
- **Efficient storage** — content-addressed SHA-256 blobs deduplicate identical files and every historical version.

## Architecture

```
Obsidian + Syncy plugin
        │  HTTPS REST + WebSocket
        ▼
   Syncy (Fastify)
        ├── SQLite: users, devices, tokens, vaults, files, versions, change log
        └── Data directory: content-addressed blobs
```

A vault is a logical namespace. The server does not parse Markdown or plugins; it stores and versions files. The plugin decides which paths are in scope, so note sync, community-plugin sync, theme sync and config sync are all the same mechanism.

## Quick start with Docker Compose

Requirements: Docker with Compose v2. Data is stored in the `syncy-data` volume.

```bash
cp .env.example .env
# Edit .env: at minimum set SYNCY_EMAIL and SYNCY_PASSWORD
docker compose up -d --build
docker compose logs -f syncy
```

Open `http://localhost:8080/healthz`. The account in `.env` is created or updated on every start. Changing `SYNCY_PASSWORD` in `.env` and restarting updates the password and revokes old refresh tokens.

To use a different host port, set `SYNCY_PORT` in `.env` (for example `SYNCY_PORT=9090`).

## Local development

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
# Edit .env
npm run dev
```

The server listens on `http://localhost:8080` and stores data under `./data` by default. `.env` is loaded automatically.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SYNCY_EMAIL` | unset | Email of the single configured account. Set together with `SYNCY_PASSWORD`. |
| `SYNCY_PASSWORD` | unset | Password (minimum 10 characters) for the configured account. |
| `SYNCY_NAME` | derived from email | Display name for the configured account. |
| `ALLOW_REGISTRATION` | `false` | Enable open `/v1/auth/register` sign-ups. Leave off for a single-user server. |
| `SETUP_TOKEN` | unset | Require this token for first-run `POST /v1/setup` when no `.env` user exists. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `8080` | Listen port inside the container/process. |
| `SYNCY_PORT` | `8080` | Docker Compose host port. |
| `DATA_DIR` | `./data` | SQLite database, JWT secret and blob storage. Compose sets `/data`. |
| `PUBLIC_URL` | `http://localhost:$PORT` | Public base URL used in discovery responses. |
| `JWT_SECRET` | auto-generated | At least 32 characters. If omitted, a secret is generated once in `DATA_DIR/.jwt-secret`. |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins, or `*`. Not needed by native clients. |
| `MAX_BLOB_BYTES` | `536870912` (512 MiB) | Maximum size of a single uploaded blob. |
| `MAX_JSON_BODY_BYTES` | `2097152` (2 MiB) | Maximum JSON request size. |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access-token lifetime. |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh-token lifetime, rotated on every use. |
| `RATE_LIMIT_MAX` | `600` | Global requests per minute per client. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so client IPs are read from forwarded headers. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |

If neither a `.env` user nor any database user exists, call `POST /v1/setup` once to create the administrator. Use `SETUP_TOKEN` on public deployments if you do not configure the account through `.env`.

## API and plugin protocol

- [API reference](docs/API.md) — endpoints, auth, sync model, conflicts, WebSocket messages and errors.
- [Plugin implementation guide](docs/PLUGIN_GUIDE.md) — how the companion plugin should store state, create file IDs, upload blobs, resolve conflicts and handle selective sync.
- [End-to-end encryption](docs/E2EE.md) — threat model, key envelopes and metadata leakage.
- [Self-hosting operations](docs/SELF_HOSTING.md) — backups, garbage collection, reverse proxy, upgrades and recovery.

### Sync flow in one paragraph

Authenticate, create or join a vault, then for every changed file: compute SHA-256, upload the blob to `PUT /v1/vaults/:id/blobs/:hash`, and push a file change with `expectedRevision` set to the revision you last saw (or `null` for a new file). Other clients subscribe to the vault over WebSocket and pull `GET /v1/vaults/:id/changes?since=<cursor>` after each notification. Conflicts return the server's current file so the plugin can pull, merge or create a conflict copy.

## Content types

No special handling is required per type. The plugin can sync:

- Markdown notes, Canvas files, databases and other text formats
- Images, audio, video, PDFs and arbitrary attachments
- `.obsidian/app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`, `community-plugins.json`
- `.obsidian/plugins/**` including each plugin's `main.js`, `manifest.json` and `data.json`
- `.obsidian/themes/**`, `.obsidian/snippets/**` and custom CSS
- Anything else under the vault root

Empty folders, case normalization, rename handling and deletion tombstones are part of the sync protocol.

## Operations

```bash
# Create a user manually (also useful for sharing)
npm run cli -- create-user --email friend@example.com --password 'a-long-password' --name Friend

# List users
npm run cli -- list-users

# Storage stats
npm run cli -- stats

# Prune old versions/change history and unreferenced blobs (dry run)
npm run cli -- gc --retention-days 90

# Apply garbage collection
npm run cli -- gc --retention-days 90 --yes --vacuum

# Backup database + blobs
npm run cli -- backup --out ./backups/manual
```

Inside Docker, run the same CLI with `docker compose exec syncy node dist/cli.js <command>`.

## Security notes

- Always run behind HTTPS in untrusted networks.
- Protect `.env` and `DATA_DIR`; the server stores credentials hashes, tokens and (unless E2EE is used) plaintext vault content.
- Prefer E2EE vaults for sensitive data. The server administrator can otherwise read all synced files.
- Keep `ALLOW_REGISTRATION=false` unless you intentionally want new accounts.
- Server backups contain everything needed to read non-E2EE vault content. Treat them as secrets.
- Syncy is a single-instance server. Do not run multiple replicas against the same SQLite database or data directory.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The integration tests exercise first-run setup, the single-user `.env` flow, token rotation and reuse detection, sharing roles, blobs and ranges, revisions and conflicts, path swaps, tombstones, version restore, E2EE opaque paths and WebSocket notifications.

## Limitations

- Not compatible with Obsidian's official Sync service or its private protocol.
- Single-node storage (SQLite + local disk). No S3 backend yet.
- No web UI; management is through the API, CLI and `.env`.
- Server-side Markdown merging is deliberately not attempted. Conflicts are surfaced to the plugin.
- WebSocket tickets are held in memory, reinforcing the single-instance design.

## License

No license has been selected yet.
