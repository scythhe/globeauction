export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, ...this.extra };
  }
}

export const Errors = {
  unauthenticated: () => new ApiError(401, "unauthenticated"),
  forbidden: () => new ApiError(403, "forbidden"),
  notFound: (resource: string) => new ApiError(404, "not_found", { resource }),
  validation: (message: string) => new ApiError(400, "validation_error", { message }),
};
