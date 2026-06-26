import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from './errorHandler.js';
import { NotFoundError, ValidationError, AppError } from '../errors.js';

/**
 * Skeleton-level tests for the centralized error handler.
 * Confirms the structured `{ error: { code, message } }` response shape
 * required by the Chat_Service error contract (Req 11.6, 11.8).
 */

function makeRes(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const noopNext: NextFunction = () => undefined;

describe('errorHandler', () => {
  it('maps an AppError to its status code and structured body', () => {
    const res = makeRes();
    errorHandler(new NotFoundError('missing'), {} as Request, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'NOT_FOUND', message: 'missing' },
    });
  });

  it('maps a ValidationError to a 400 structured body', () => {
    const res = makeRes();
    errorHandler(new ValidationError('bad input'), {} as Request, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'VALIDATION_ERROR', message: 'bad input' },
    });
  });

  it('maps an unknown error to a 500 structured body', () => {
    const res = makeRes();
    errorHandler(new Error('boom'), {} as Request, res, noopNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });

  it('AppError instances carry statusCode and code', () => {
    const err = new AppError('x', 418, 'TEAPOT');
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe('TEAPOT');
    expect(err).toBeInstanceOf(Error);
  });
});
