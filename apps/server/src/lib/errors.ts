import { ZodError } from 'zod';

export const ErrorCodes = {
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SHARE_LINK_EXPIRED: 410,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  GARMENT_RETIRED: 409,
  DAMAGE_ALREADY_RESOLVED: 409,
  OBSERVATION_NOT_FINISHED: 409,
  PHOTO_IN_USE: 409,
  INVENTORY_INSUFFICIENT: 409,
  REMINDER_ALREADY_HANDLED: 409,
  VALIDATION_FAILED: 422,
  DAMAGE_LOCATION_REQUIRED: 422,
  REPAIR_CHANGE_REQUIRED: 422,
  UPLOAD_TYPE_NOT_ALLOWED: 415,
  UPLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = ErrorCodes[code] ?? 500;
    this.details = details;
  }
}

export function notFound(what = '记录'): HttpError {
  return new HttpError('NOT_FOUND', `${what}不存在或无权访问`);
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError('VALIDATION_FAILED', message, details);
}

export function conflict(code: ErrorCode, message: string, details?: unknown): HttpError {
  return new HttpError(code, message, details);
}

export function zodIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
