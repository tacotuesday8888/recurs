export type IntegrationErrorCode =
  | "adapter_unavailable"
  | "connection_not_found"
  | "connection_invalid"
  | "account_mismatch"
  | "authentication_required"
  | "authentication_failed"
  | "authorization_denied"
  | "credential_unavailable"
  | "credential_store_locked"
  | "secure_storage_unavailable"
  | "model_unavailable"
  | "model_incompatible"
  | "rate_limited"
  | "plan_limit_reached"
  | "quota_exhausted"
  | "context_overflow"
  | "protocol_mismatch"
  | "policy_blocked"
  | "policy_stale"
  | "billing_policy_blocked"
  | "session_conflict"
  | "continuation_incompatible"
  | "continuation_uncertain"
  | "runtime_capability_missing"
  | "transport"
  | "timeout"
  | "cancelled"
  | "invalid_response"
  | "tool_failed"
  | "runtime_failed";

export interface IntegrationFailure {
  domain:
    | "connection"
    | "auth"
    | "catalog"
    | "policy"
    | "provider"
    | "runtime"
    | "storage"
    | "tool";
  phase: "preflight" | "started";
  code: IntegrationErrorCode;
  safeMessage: string;
  diagnosticId: string;
  retryable: boolean;
  retryAfterMs?: number;
  action?:
    | "reauthenticate"
    | "select_connection"
    | "select_model"
    | "confirm_billing"
    | "fork_session"
    | "unlock_store"
    | "wait";
}
