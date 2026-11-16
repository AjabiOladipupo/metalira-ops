import { Constants, type Database } from "@/types/db";

/** A membership role, as stored in `public.memberships.role`. */
export type Role = Database["public"]["Enums"]["membership_role"];

/** Every role, in the order of the database enum. */
export const ROLES: readonly Role[] = Constants.public.Enums.membership_role;

/** Roles that use the manager app at /app. Workers use /m; client approvers have no app yet. */
export const MANAGER_ROLES = [
  "owner",
  "admin",
  "hr",
  "finance",
  "ops_manager",
  "line_manager",
] as const satisfies readonly Role[];

export type ManagerRole = (typeof MANAGER_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  hr: "HR",
  finance: "Finance",
  ops_manager: "Operations manager",
  line_manager: "Line manager",
  worker: "Worker",
  client_approver: "Client approver",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isManagerRole(role: Role): role is ManagerRole {
  return (MANAGER_ROLES as readonly Role[]).includes(role);
}
