import { decodeLineManager } from "@/lib/people";
import { isAuditSecretKey } from "@/server/identity/audit";

/**
 * Turning People form fields into helper input (slice 1.5). Pure, so the mapping is unit-tested
 * without a request.
 */

/** Checkboxes send nothing when unticked; the helpers need an explicit true or false. */
const CHECKBOXES = ["nhfOptIn", "supervisorClockIn"] as const;

/**
 * Input for `createWorker` or `updateWorker` from the worker form. The single line-manager
 * select (`lineManager`, `w:<id>` or `m:<id>`) becomes the two columns, always both, so picking
 * one clears the other and an empty choice clears both. In an update the staff ID and bank
 * fields are never sent (they have their own flows; the schema refuses them).
 */
export function workerFormInput(
  fields: Record<string, string>,
  mode: "create" | "update",
): Record<string, string | null> {
  const input: Record<string, string | null> = { ...fields };
  delete input.lineManager;
  Object.assign(input, decodeLineManager(fields.lineManager));
  for (const key of CHECKBOXES) input[key] = fields[key] ? "true" : "false";
  if (mode === "update") {
    delete input.staffId;
    delete input.bankName;
    delete input.accountName;
    delete input.bankAccountNumber;
  }
  return input;
}

/** Field errors keyed by the form's input names (the two line-manager columns share one select). */
export function workerFormErrors(
  fieldErrors: Partial<Record<string, string>>,
): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const [key, message] of Object.entries(fieldErrors)) {
    const name =
      key === "lineManagerWorkerId" || key === "lineManagerMembershipId" ? "lineManager" : key;
    out[name] ??= message;
  }
  return out;
}

/**
 * What a refused form gets back to refill its inputs: everything typed except personal data
 * (NIN, bank account number, RSA PIN), which is never sent back to the browser, and Next's own
 * action fields.
 */
export function echoableValues(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("$ACTION") || isAuditSecretKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Input for `saveMapping` from the mapping panel: the single line-manager select becomes the
 * two columns (as in the worker form), and the project checkboxes, which share one name,
 * become a list.
 */
export function mappingFormInput(formData: FormData): Record<string, unknown> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    workerId: text("workerId"),
    departmentId: text("departmentId"),
    ...decodeLineManager(text("lineManager")),
    siteId: text("siteId"),
    projectIds: formData
      .getAll("projectIds")
      .filter((value): value is string => typeof value === "string" && value.trim() !== ""),
  };
}
