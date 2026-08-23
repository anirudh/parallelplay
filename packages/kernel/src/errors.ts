export type SetupErrorCode =
  "DATABASE_NOT_FOUND" | "MIGRATION_REQUIRED" | "MIGRATION_DRIFT" | "MIGRATION_AHEAD";

export class KernelSetupError extends Error {
  readonly code: SetupErrorCode;
  readonly details?: Record<string, string | number>;

  constructor(code: SetupErrorCode, message: string, details?: Record<string, string | number>) {
    super(message);
    this.name = "KernelSetupError";
    this.code = code;
    if (details) this.details = details;
  }
}
