export type SessionStoreErrorCode =
  | "invalid_session_id"
  | "session_busy"
  | "session_not_found"
  | "session_conflict"
  | "legacy_read_only"
  | "session_mismatch"
  | "unsupported_version"
  | "invalid_record"
  | "corrupt_log";

export class SessionStoreError extends Error {
  constructor(
    public readonly code: SessionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}
