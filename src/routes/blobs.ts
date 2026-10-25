import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { blobReferenced } from '../db/sync.js';
import { requireVaultAccess } from '../db/vaults.js';
import { badRequest, notFound } from '../errors.js';
import { blobParams } from './schemas.js';

interface ByteRange {
  start: number;
  end: number;
  partial: boolean;
}

function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;

  if (!startText) {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1, partial: true };
  }

  const start = Number.parseInt(startText, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) return null;

  const end = endText ? Number.parseInt(endText, 10) : size - 1;
  if (!Number.isFinite(end) || end < start) return null;

  return { start, end: Math.min(end, size - 1), partial: true };
}

function sendRangeError(reply: FastifyReply, size: number) {
  return reply
    .status(416)
    .header('Content-Range', `bytes */${size}`)
    .send({
      error: {
        code: 'RANGE_NOT_SATISFIABLE',
        message: 'The requested byte range cannot be satisfied',
      },
    });
}

export async function registerBlobRoutes(app: FastifyInstance): Promise<void> {
  app.put(
    '/v1/vaults/:vaultId/blobs/:hash',
    { preHandler: app.authenticate, bodyLimit: app.config.maxBlobBytes },
    async (request, reply) => {
      const { vaultId, hash } = blobParams.parse(request.params);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'editor');

      const body = request.body as Readable | undefined;
      if (!body || typeof body.pipe !== 'function') {
        throw badRequest('BLOB_REQUIRED', 'Send the blob as application/octet-stream');
      }

      const result = await app.blobs.putStream(hash, body);
      return reply.status(result.deduped ? 200 : 201).send(result);
    },
  );

  app.head(
    '/v1/vaults/:vaultId/blobs/:hash',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { vaultId, hash } = blobParams.parse(request.params);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id, 'editor');
      const exists = await app.blobs.has(hash);
      return reply
        .status(exists ? 200 : 404)
        .header('x-syncy-blob-exists', exists ? 'true' : 'false')
        .send();
    },
  );

  app.get(
    '/v1/vaults/:vaultId/blobs/:hash',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { vaultId, hash } = blobParams.parse(request.params);
      requireVaultAccess(app.db, vaultId, request.auth!.user.id);

      if (!blobReferenced(app.db, vaultId, hash)) {
        throw notFound('BLOB_NOT_FOUND', 'Blob not found in this vault');
      }

      const info = await app.blobs.stat(hash);
      if (!info) throw notFound('BLOB_NOT_FOUND', 'Blob not found');

      const etag = `"${hash}"`;
      if (request.headers['if-none-match'] === etag) {
        return reply.status(304).send();
      }

      const range = parseRange(request.headers.range, info.size);
      if (request.headers.range && !range) {
        return sendRangeError(reply, info.size);
      }

      reply
        .header('Content-Type', 'application/octet-stream')
        .header('Accept-Ranges', 'bytes')
        .header('ETag', etag)
        .header('Cache-Control', 'private, max-age=31536000, immutable');

      if (range) {
        reply
          .status(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
          .header('Content-Length', String(range.end - range.start + 1));
        return reply.send(app.blobs.createReadStream(hash, range.start, range.end));
      }

      reply.status(200).header('Content-Length', String(info.size));
      return reply.send(app.blobs.createReadStream(hash));
    },
  );
}
