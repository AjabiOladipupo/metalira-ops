/**
 * Which door a change came through, recorded on every `audit_log` row (`channel`, slice 2.1):
 *
 * - `web`: the manager app. The default.
 * - `worker_app`: the worker app under /m.
 * - `import`: committing a people import.
 * - `system`: scheduled jobs and server tasks with no signed-in user.
 * - `lira`: the ops agent (docs/LIRA.md). Reserved: no server path sends it yet, and the
 *   database does not accept it from a request header.
 *
 * The server's Supabase clients send the channel as a request header and a database trigger
 * (private.audit_log_set_channel) copies it onto the row. It is a label for reading the log,
 * never a permission: the actor on the row is always the signed-in user.
 */
export const AUDIT_CHANNELS = ["web", "worker_app", "import", "system", "lira"] as const;

export type AuditChannel = (typeof AUDIT_CHANNELS)[number];

/** Channels a server path may send today. */
export type SendableAuditChannel = Exclude<AuditChannel, "lira">;

/** Request header the database reads the channel from (lower case, as PostgREST exposes it). */
export const AUDIT_CHANNEL_HEADER = "x-metalira-channel";

export function auditChannelHeaders(channel: SendableAuditChannel): Record<string, string> {
  return { [AUDIT_CHANNEL_HEADER]: channel };
}
