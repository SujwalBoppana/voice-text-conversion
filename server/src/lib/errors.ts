export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Retry with exponential backoff on transient upstream failures only. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 400, label = 'operation' } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} attempt ${attempt} failed, retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  const message = String((error as Error)?.message ?? '');
  return /429|resource exhausted|unavailable|deadline|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    message,
  );
}
