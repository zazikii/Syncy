# Self-hosting Syncy

Syncy is designed for a single server with local disk. SQLite holds metadata and a content-addressed blob store holds file content. Both live in one data directory.

## Docker Compose

```bash
cp .env.example .env
```

Set at least:

```dotenv
SYNCY_EMAIL=you@example.com
SYNCY_PASSWORD=a-long-random-password
PUBLIC_URL=https://sync.example.com
SYNCY_PORT=8080
```

Then:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f syncy
curl http://localhost:8080/healthz
```

The container runs as the unprivileged `node` user and stores everything in the `syncy-data` volume mounted at `/data`.

### Using a bind mount

If you prefer a host directory:

```yaml
services:
  syncy:
    volumes:
      - ./data:/data
```

Ensure the host directory is writable by UID/GID 1000:

```bash
sudo chown -R 1000:1000 ./data
```

### Host port

`SYNCY_PORT` controls the host port. The container always listens on `8080` internally.

```dotenv
SYNCY_PORT=9090
```

## The single-user model

For a personal server, configure one account in `.env`:

```dotenv
SYNCY_EMAIL=you@example.com
SYNCY_PASSWORD=a-long-random-password
SYNCY_NAME=You
ALLOW_REGISTRATION=false
```

On every start, Syncy:

1. Creates the account if it does not exist.
2. Promotes it to administrator.
3. Re-enables it if it was disabled.
4. If the `.env` password no longer matches, rehashes it and revokes all refresh tokens.

Changing the password in `.env` and restarting is therefore enough to rotate the login password. Existing access tokens remain valid for up to 15 minutes; refresh tokens are revoked immediately.

To add more accounts (for vault sharing), either enable registration temporarily or use the CLI:

```bash
docker compose exec syncy node dist/cli.js create-user \
  --email friend@example.com --password 'a-long-password' --name Friend
```

## Data layout

```
/data/
├── syncy.db          SQLite database (users, vaults, metadata, change log)
├── syncy.db-wal      SQLite WAL
├── syncy.db-shm
├── .jwt-secret       Generated JWT signing secret
└── blobs/
    └── ab/cd/abcdef...   Content-addressed blob (SHA-256 filename)
```

- Blobs are write-once and deduplicated across files, versions and vaults.
- Deleting a vault does not delete blobs immediately; run garbage collection.
- Do not edit the database or blob files by hand while Syncy is running.
- Do not run multiple Syncy instances against the same data directory or SQLite file.

## Reverse proxy and HTTPS

Run Syncy behind a TLS-terminating reverse proxy. Set:

```dotenv
TRUST_PROXY=true
PUBLIC_URL=https://sync.example.com
```

### Caddy

```caddyfile
sync.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Caddy handles HTTP and WebSocket upgrades automatically.

### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name sync.example.com;

  ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

  client_max_body_size 512m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

`proxy_request_buffering off` and a generous body limit matter for large attachments. The WebSocket endpoint is `/v1/ws`.

Set `TRUST_PROXY=true` only when a trusted proxy is directly in front of Syncy; otherwise clients can spoof forwarded IPs and bypass rate limits.

## Backups

The database and blobs must be backed up together. Blobs are content-addressed and immutable, so copying them while the server runs is generally safe; the database should use SQLite's online backup or a stopped server.

### Online backup using the CLI

```bash
docker compose exec syncy node dist/cli.js backup --out /data/backups/2026-10-25
docker compose cp syncy:/data/backups/2026-10-25 ./backups/2026-10-25
```

This uses SQLite's backup API and copies the blob directory. For a perfectly consistent snapshot, stop the container first.

### Stopped-volume backup

```bash
docker compose stop syncy
docker run --rm \
  -v syncy-data:/data \
  -v "${PWD}/backups:/backups" \
  alpine sh -c 'cd /data && tar czf /backups/syncy-$(date +%Y%m%d-%H%M%S).tar.gz .'
docker compose start syncy
```

The CLI backup also copies `.jwt-secret` when it exists. Back up your `.env` separately (or keep it in a secret manager): it contains `SYNCY_PASSWORD`, possibly `JWT_SECRET`, and the other deployment settings. If you set `JWT_SECRET` through the environment instead of a file, the backup will not contain it.

Treat backups as secrets. Without E2EE, they contain plaintext notes and plugin tokens. With E2EE, they still contain metadata and ciphertext.

### Restore

```bash
docker compose stop syncy
docker run --rm \
  -v syncy-data:/data \
  -v "${PWD}/backups:/backups" \
  alpine sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backups/syncy-YYYYMMDD-HHMMSS.tar.gz -C /data'
docker compose start syncy
```

Restoring an older database can leave clients with cursors ahead of the server. They receive `CURSOR_AHEAD` and perform a full resync. This is expected.

## Garbage collection and retention

Every accepted change is kept as a version. Without pruning, storage grows with history. Use the CLI:

```bash
# Dry run: show what would be pruned
docker compose exec syncy node dist/cli.js gc --retention-days 90

# Apply, keeping the latest version of every file
docker compose exec syncy node dist/cli.js gc --retention-days 90 --yes --vacuum
```

`--retention-days 90` removes non-latest versions older than 90 days. It also prunes the change log up to the highest removed revision and advances `prunedBeforeRevision`. Clients with an older cursor receive `410 CURSOR_EXPIRED` and rebuild from a snapshot.

Unreferenced blobs older than `--grace-hours` (default 24) are deleted. The grace period avoids deleting a blob that was uploaded but not yet referenced by a change.

Run GC during a quiet period. It is a dry run unless `--yes` is provided.

Other CLI commands:

```bash
docker compose exec syncy node dist/cli.js stats
docker compose exec syncy node dist/cli.js list-users
docker compose exec syncy node dist/cli.js vacuum
```

## Upgrades

1. Back up the data volume.
2. Pull/build the new image:
   ```bash
   docker compose build --pull
   docker compose up -d
   ```
3. Check logs and health:
   ```bash
   docker compose logs --tail=100 syncy
   curl -fsS https://sync.example.com/healthz
   ```

SQLite migrations run automatically on startup. Downgrading may not be supported; restore the backup if needed.

## Monitoring

- `GET /healthz` — process is alive.
- `GET /readyz` — database is reachable.
- `GET /v1/admin/stats` — users, vaults, devices, blob count, storage usage, connected sockets. Requires an admin token.
- Logs are structured JSON. Use `LOG_LEVEL=info` normally, `debug` temporarily for troubleshooting.
- Rate-limit failures return `429 RATE_LIMITED`.

## Security checklist

- [ ] HTTPS with a valid certificate.
- [ ] Long random `SYNCY_PASSWORD`.
- [ ] `ALLOW_REGISTRATION=false`.
- [ ] `SETUP_TOKEN` set if no `.env` user is configured.
- [ ] `TRUST_PROXY=true` only behind a trusted proxy.
- [ ] Data volume permissions restricted to the Syncy container user.
- [ ] Backups encrypted at rest and stored off-host.
- [ ] E2EE enabled for vaults containing sensitive data or plugin credentials.
- [ ] Review vault memberships regularly.
- [ ] Keep the host, Docker and Node images updated.

## Troubleshooting

### `413 BODY_TOO_LARGE`

Increase `MAX_BLOB_BYTES` for Syncy and the reverse proxy body limit (`client_max_body_size` in Nginx).

### `401 DEVICE_REVOKED`

The device was removed from the account. Log in again to register a new device.

### WebSocket disconnects through a proxy

Ensure HTTP/1.1 upgrade headers are forwarded, or use a proxy such as Caddy that handles WebSockets automatically. Set generous read/send timeouts.

### `SQLITE_BUSY` or database locked

Run exactly one Syncy instance against the data directory. Do not point two containers at the same SQLite file. Check for stale processes. `busy_timeout` is 5 seconds.

### Blob upload succeeds but push says `BLOB_MISSING`

The blob may have been garbage-collected before it was referenced, or the hash was computed over different bytes. Upload and push promptly, and check the hash calculation (ciphertext for E2EE). The default GC grace period is 24 hours.

### Version history disappeared

Check `prunedBeforeRevision` on the vault. GC removes old versions and change history. This is intentional; adjust `--retention-days`.

### Clients loop or re-upload constantly

Make sure the plugin hashes file bytes, ignores its own writes, and does not sync its cursor/file-ID state. See [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md).
