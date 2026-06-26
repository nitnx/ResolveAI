import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { AppError } from '../errors.js';

/**
 * Centralized error handler middleware.
 * All errors are normalized to { error: { code, message } } with an appropriate status code.
 * Must be registered after all other middleware and routes.
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // Unknown / unhandled error — do not leak internals
  const message =
    err instanceof Error ? err.message : 'An unexpected error occurred';

  console.error('[ErrorHandler] Unhandled error:', err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message,
    },
  });
};
