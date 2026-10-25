import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, badRequest } from '../errors.js';
import { isSha256 } from '../utils/hash.js';
import { newId } from '../utils/ids.js';

export interface BlobStat {
  size: number;
  mtimeMs: number;
}

export interface PutBlobResult {
  hash: string;
  size: number;
  deduped: boolean;
}

export class LocalBlobStore {
  readonly root: string;
  private readonly tmpDir: string;
  private readonly maxBytes: number;

  constructor(root: string, maxBytes: number) {
    this.root = root;
    this.tmpDir = path.join(root, '.tmp');
    this.maxBytes = maxBytes;
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
  }

  blobPath(hash: string): string {
    if (!isSha256(hash)) {
      throw badRequest('INVALID_BLOB_HASH', 'Blob hash must be a lowercase SHA-256 hex digest');
    }
    return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async has(hash: string): Promise<boolean> {
    try {
      const info = await stat(this.blobPath(hash));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async stat(hash: string): Promise<BlobStat | null> {
    try {
      const info = await stat(this.blobPath(hash));
      if (!info.isFile()) return null;
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  async putStream(expectedHash: string, stream: Readable): Promise<PutBlobResult> {
    const target = this.blobPath(expectedHash);
    const existing = await this.stat(expectedHash);

    if (existing) {
      await this.drain(stream);
      return { hash: expectedHash, size: existing.size, deduped: true };
    }

    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tempPath = path.join(this.tmpDir, `${newId()}.part`);
    const hash = createHash('sha256');
    let size = 0;

    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.maxBytes) {
          callback(new AppError(413, 'BLOB_TOO_LARGE', 'Uploaded blob exceeds the size limit'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(stream, meter, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      const actualHash = hash.digest('hex');

      if (actualHash !== expectedHash) {
        await unlink(tempPath).catch(() => undefined);
        throw badRequest(
          'BLOB_HASH_MISMATCH',
          'The uploaded content does not match the provided SHA-256 hash',
          { expected: expectedHash, actual: actualHash },
        );
      }

      try {
        await rename(tempPath, target);
      } catch (error) {
        const current = await this.stat(expectedHash);
        if (current) {
          await unlink(tempPath).catch(() => undefined);
          return { hash: expectedHash, size: current.size, deduped: true };
        }
        throw error;
      }

      return { hash: expectedHash, size, deduped: false };
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  createReadStream(hash: string, start?: number, end?: number): Readable {
    return createReadStream(this.blobPath(hash), { start, end });
  }

  async remove(hash: string): Promise<boolean> {
    try {
      await unlink(this.blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<Array<{ hash: string; mtimeMs: number; size: number }>> {
    const blobs: Array<{ hash: string; mtimeMs: number; size: number }> = [];
    let firstLevel: string[] = [];

    try {
      firstLevel = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return blobs;
    }

    for (const first of firstLevel) {
      let secondLevel: string[] = [];
      try {
        secondLevel = (await readdir(path.join(this.root, first), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        continue;
      }

      for (const second of secondLevel) {
        let files: string[] = [];
        try {
          files = (await readdir(path.join(this.root, first, second), { withFileTypes: true }))
            .filter((entry) => entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name))
            .map((entry) => entry.name);
        } catch {
          continue;
        }

        for (const hash of files) {
          if (!isSha256(hash)) continue;
          try {
            const info = await stat(path.join(this.root, first, second, hash));
            blobs.push({ hash, mtimeMs: info.mtimeMs, size: info.size });
          } catch {}
        }
      }
    }

    return blobs;
  }

  private async drain(stream: Readable): Promise<void> {
    let size = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.maxBytes) {
          callback(new AppError(413, 'BLOB_TOO_LARGE', 'Uploaded blob exceeds the size limit'));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      stream,
      meter,
      new Writable({
        write: (_chunk, _encoding, callback) => callback(),
      }),
    );
  }
}
