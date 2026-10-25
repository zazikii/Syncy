import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message: string, details?: unknown): AppError {
  return new AppError(400, code, message, details);
}

export function unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required'): AppError {
  return new AppError(401, code, message);
}

export function forbidden(
  code = 'FORBIDDEN',
  message = 'You do not have access to this resource',
): AppError {
  return new AppError(403, code, message);
}

export function notFound(code = 'NOT_FOUND', message = 'Resource not found'): AppError {
  return new AppError(404, code, message);
}

export function conflict(code: string, message: string, details?: unknown): AppError {
  return new AppError(409, code, message, details);
}

export function gone(code: string, message: string, details?: unknown): AppError {
  return new AppError(410, code, message, details);
}

export function errorBody(code: string, message: string, details?: unknown) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

interface FastifyLikeError extends Error {
  statusCode?: number;
  code?: string;
  validation?: unknown;
}

export function registerErrorHandler(
  error: FastifyLikeError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send(errorBody(error.code, error.message, error.details));
  }

  if (error instanceof ZodError) {
    return reply.status(400).send(
      errorBody('VALIDATION_ERROR', 'Request validation failed', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    );
  }

  const statusCode = error.statusCode ?? 500;

  if (statusCode === 413) {
    return reply.status(413).send(errorBody('BODY_TOO_LARGE', 'Request body is too large'));
  }

  if (statusCode === 429) {
    return reply.status(429).send(errorBody('RATE_LIMITED', 'Too many requests'));
  }

  if (statusCode >= 400 && statusCode < 500) {
    return reply
      .status(statusCode)
      .send(errorBody(error.code ?? 'REQUEST_ERROR', error.message || 'Request failed'));
  }

  request.log.error({ err: error }, 'Unhandled request error');
  return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
}
