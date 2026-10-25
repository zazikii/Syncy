# End-to-end encryption

Syncy supports per-vault end-to-end encryption. The server acts as an authenticated, content-addressed transport and version store; it never receives the vault key.

E2EE is a client feature. The server API carries opaque values and stores key envelopes, but the companion plugin implements the cryptography.

## What the server sees

For an E2EE vault, the server sees:

- Vault name, owner, members, roles and key envelopes (opaque ciphertext)
- Number of files and folders
- Opaque encrypted paths
- File sizes, content hashes of ciphertext, timestamps and revisions
- Device names, user emails, IP addresses and request timing
- Which user/device made which change
- Version history metadata and ciphertext blobs

The server does **not** see:

- Plaintext paths or filenames
- Plaintext file content
- The vault key or per-member wrapping keys
- Searchable plaintext metadata inside encrypted files

Traffic analysis, size patterns and access patterns remain visible. Encrypting paths hides directory structure, but a server administrator can still see that a vault has N files and how often they change.

## Recommended cryptography

There is no single required construction, but the plugin should use modern AEAD and explicit domain separation.

### Vault key

- Generate 32 random bytes once, on the first device.
- Never send the raw vault key to the server.
- Use a separate key for content and path encryption if practical, derived with HKDF:
  - `contentKey = HKDF(vaultKey, "syncy-content-v1")`
  - `pathKey = HKDF(vaultKey, "syncy-path-v1")`
  - `fileIdKey = HKDF(vaultKey, "syncy-file-id-v1")`

### Content

Recommended: XChaCha20-Poly1305 (libsodium) or AES-256-GCM.

- Fresh random nonce per file version.
- Bind the encrypted path or stable file ID as associated data if the format allows.
- Store any nonce/header inside the ciphertext blob; the server treats the blob as opaque.
- The server hash is the SHA-256 of the ciphertext, not plaintext.

### Paths

- Encrypt each path with an AEAD using a fresh nonce.
- Encode the result as a URL-safe string so it fits the `path` field (maximum 16,384 characters).
- Keep the `fileId` stable and independent of the encrypted path. The server indexes by `fileId`; path uniqueness is not enforced for E2EE vaults.
- A common encoding is `base64url(nonce || ciphertext)`.
- Normalize plaintext paths (NFC, `/` separators) before encrypting so equivalent paths behave consistently.

### File IDs

To let independent devices seed the same existing vault without colliding, derive initial IDs deterministically:

```
fileId = base32(HMAC-SHA256(fileIdKey, "syncy-file-id:" + normalizedPlaintextPath)).slice(0, 32)
```

New files created after initial sync can use random UUIDs. Once assigned, keep the ID across renames and edits. The deterministic ID reveals nothing to the server as long as the HMAC key stays secret; it is stable and not reversible.

## Key envelopes

The server stores one opaque `keyEnvelope` per vault member:

- `vault_members.key_envelope` is set at vault creation for the owner and via `PATCH /v1/vaults/:id/members/:userId`.
- `GET /v1/vaults/:id` returns the requesting user's own envelope.
- The owner can read and set envelopes for other members.
- Envelopes are size-limited (65,536 characters) but otherwise uninterpreted.

A typical envelope is a JSON object encoded as a string:

```json
{
  "v": 1,
  "kdf": "argon2id",
  "salt": "base64url",
  "nonce": "base64url",
  "ciphertext": "base64url"
}
```

or a public-key wrapped key:

```json
{
  "v": 1,
  "alg": "x25519-xsalsa20-poly1305",
  "ephemeralPublicKey": "base64url",
  "nonce": "base64url",
  "ciphertext": "base64url"
}
```

The server does not validate either shape.

## Do not reuse the login password as the E2EE key

The login password is sent to the server for authentication. The vault key must not be derivable from it without a separate secret, or the server could derive the vault key during login.

Recommended model:

- The user chooses an **E2EE passphrase** that is never sent to the server.
- A key-encryption key (KEK) is derived with Argon2id using a random salt.
- The vault key is wrapped with the KEK and stored in the owner's envelope.
- Every device asks for the passphrase once and unlocks the vault locally.

Alternatives:

- Device keypair + owner approval (X25519): each device generates a keypair; the owner wraps the vault key for the device's public key and uploads the envelope.
- Recovery key: generate a high-entropy recovery key; store an additional envelope in the owner's secure records.

## Multi-device access

The server stores one envelope per **member**, not per device. The plugin must choose how a member's devices obtain the vault key:

1. **Passphrase-derived KEK** — all devices derive the same KEK from the E2EE passphrase and the stored salt. Simple and works with the current server model.
2. **Per-user master key** — derive a user master key once and wrap each member's vault key with it. Devices need a way to obtain the user master key (passphrase, keychain, device pairing).
3. **Per-device envelopes with an external key store** — requires a more advanced key distribution protocol; the current server stores only one envelope per member, so the envelope must contain a structure the plugin can use for all of that member's devices.

Changing the E2EE passphrase means rewrapping the vault key and updating the owner's envelope. It does not require re-encrypting file content.

## Sharing E2EE vaults

1. Add the member with `POST /v1/vaults/:id/members` and a role.
2. The owner's client unwraps the vault key from its own envelope.
3. The owner wraps the vault key for the new member using that member's public key or a shared passphrase.
4. The owner stores it with `PATCH /v1/vaults/:id/members/:userId` using `keyEnvelope`.
5. The new member fetches the vault and envelope, unlocks, and syncs.

A member with `hasKeyEnvelope: false` must not attempt to decrypt the vault. The owner should see this state in the member list and provide the envelope.

When removing a member:

- Remove them from the vault immediately. The server drops their live WebSocket subscription and they lose API access.
- They may still retain any vault key and files they already decrypted. E2EE cannot revoke data already copied.
- For stronger forward secrecy, rotate the vault key after removal, re-encrypt future content, and redistribute envelopes. The current server does not automate key rotation; the plugin must implement it.

## Version history and E2EE

- Version metadata stores ciphertext hashes and encrypted paths.
- Version content is the ciphertext blob. Anyone with the vault key can decrypt historical versions.
- Delete tombstones do not erase ciphertext immediately; blobs are removed by garbage collection once unreferenced.
- "Delete permanently after X days" is an operational policy, not a cryptographic guarantee.

## Threat model summary

E2EE protects against:

- A server administrator reading vault content
- Database/backup theft exposing plaintext notes
- A compromised storage backend reading files
- Other users without the vault key

E2EE does not protect against:

- A compromised device or plugin installation
- Malicious clients that are legitimate vault members
- Traffic analysis, file sizes and timing
- Loss of the E2EE passphrase/key (no server-side recovery)
- A server administrator modifying ciphertext or metadata (clients should verify hashes and authenticated ciphertext; the server does not provide a signed transparency log)

## Operational guidance

- Store the E2EE passphrase in a password manager and keep offline recovery material.
- Do not commit vault keys, envelopes or passphrases to the notes vault.
- Treat encrypted vault backups as sensitive: they still contain metadata and ciphertext.
- Audit membership regularly. Removing a member is not a cryptographic erase.
- Prefer E2EE for plugin `data.json` files that contain API tokens.
