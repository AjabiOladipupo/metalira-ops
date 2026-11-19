import { Status } from "@/components/status";
import type { ContractStatus } from "@/server/business/contract-schemas";

/** Draft (hollow), Active (solid), Ended (half). */
export function ContractStatusChip({ status }: { status: ContractStatus }) {
  if (status === "active") return <Status tone="done">Active</Status>;
  if (status === "ended") return <Status tone="partial">Ended</Status>;
  return <Status tone="pending">Draft</Status>;
}
