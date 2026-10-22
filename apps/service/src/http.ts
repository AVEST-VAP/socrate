import type { ApiError, ErrorCode } from '@socrate/contract';

export class HttpError extends Error {
  status: number;
  code: ErrorCode;
  retryable: boolean;
  issues: ApiError['issues'];
  constructor(status: number, code: ErrorCode, message: string, retryable = false, issues?: ApiError['issues']) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.issues = issues;
  }
}

export const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS, ...headers } });
}

export function errorResponse(e: HttpError, requestId: string, headers: Record<string, string> = {}): Response {
  const body: ApiError = { code: e.code, message: e.message, requestId, retryable: e.retryable, ...(e.issues ? { issues: e.issues } : {}) };
  return json(body, e.status, headers);
}

export async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.startsWith('application/json')) throw new HttpError(422, 'invalid_request', 'Content-Type application/json attendu');
  try {
    return await request.json();
  } catch {
    throw new HttpError(422, 'invalid_request', 'corps JSON illisible');
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
