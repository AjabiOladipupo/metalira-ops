import "server-only";

import { z } from "zod";

import { bankByCode, bankFromName } from "@/lib/banks";
import type { ManagerRole } from "@/lib/roles";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  LOOKUP_MESSAGES,
  loadWorkerNames,
  runBankLookup,
  type BankLookupView,
  type ExpectedNames,
} from "@/server/billing/bank-lookup";
import { bankCodeSchema } from "@/server/billing/bank-check-schema";
import { PiiDecryptError, decryptPii } from "@/server/crypto/pii";
import { logAuditEvent } from "@/server/identity/audit";
import { getSession } from "@/server/identity/session";

import { bankAccountContext } from "./bank-changes";
import { checkWorkerBankSchema, nubanSchema } from "./schemas";
import { PEOPLE_EDITORS } from "./workers";

/**
 * Account name lookups for worker bank details (slice 2.3b):
 *
 * - `lookupWorkerBankAccount`: "Check" in Add employee and Change bank details. Compared with
 *   the employee's first and last name: from the record for an existing employee, from the form
 *   for one being added (the server compares again with the names actually saved).
 * - `checkWorkerBankDetails`: "Check bank details" on the person page, for bank details that
 *   were never checked (the people import never looks names up per row). The server decrypts the
 *   number on file and looks it up; the result is kept on the worker
 *   (`workers.bank_checked_*`) and audited as `people.bank_details_checked`, without the number.
 *
 * Owner, admin and HR (the people who edit employees). Nothing here logs input.
 */

export type BankLookupFailure = Extract<BankLookupView, { ok: false }>;

function fail(message: string): BankLookupFailure {
  return { ok: false, message };
}

function firstIssue(error: z.ZodError): BankLookupFailure {
  const issue = error.issues[0];
  const key = issue?.path[0];
  return {
    ok: false,
    message: issue?.message ?? "Check the bank and account number.",
    ...(key === "bankCode" || key === "bankAccountNumber" ? { field: key } : {}),
  };
}

async function editorSession(): Promise<
  { userId: string; organisationId: string; role: ManagerRole } | BankLookupFailure
> {
  const session = await getSession();
  if (!session?.active) return fail("Sign in again to check bank details.");
  if (!(PEOPLE_EDITORS as readonly ManagerRole[]).includes(session.active.role)) {
    return fail("Only an owner, an admin or HR can check bank details.");
  }
  return {
    userId: session.user.id,
    organisationId: session.active.organisationId,
    role: session.active.role,
  };
}

const plainName = z.string().trim().min(1).max(200);

export const lookupWorkerBankSchema = z.object({
  /** An existing employee; absent when adding one. */
  workerId: z.uuid().nullish(),
  /** The names typed in Add employee (ignored for an existing employee). */
  firstName: plainName.nullish(),
  lastName: plainName.nullish(),
  bankCode: bankCodeSchema,
  bankAccountNumber: nubanSchema,
});

export async function lookupWorkerBankAccount(input: unknown): Promise<BankLookupView> {
  const parsed = lookupWorkerBankSchema.safeParse(input);
  if (!parsed.success) return firstIssue(parsed.error);
  const who = await editorSession();
  if ("ok" in who) return who;
  const data = parsed.data;
  try {
    let expected: ExpectedNames | null;
    if (data.workerId) {
      const supabase = await createServerSupabase();
      expected = await loadWorkerNames(supabase, who.organisationId, data.workerId);
      if (!expected) return fail("That employee wasn't found.");
    } else {
      if (!data.firstName || !data.lastName) {
        return fail(
          "Enter the employee's first and last name first, so the bank's name can be compared.",
        );
      }
      expected = { kind: "person", firstName: data.firstName, lastName: data.lastName };
    }
    return await runBankLookup({
      organisationId: who.organisationId,
      userId: who.userId,
      purpose: "worker_bank",
      workerId: data.workerId ?? null,
      bankCode: data.bankCode,
      accountNumber: data.bankAccountNumber,
      expected,
    });
  } catch (error) {
    console.error("people.bank_lookup_failed:", error instanceof Error ? error.name : "unknown");
    return fail(LOOKUP_MESSAGES.failed);
  }
}

export async function checkWorkerBankDetails(input: unknown): Promise<BankLookupView> {
  const parsed = checkWorkerBankSchema.safeParse(input);
  if (!parsed.success) return firstIssue(parsed.error);
  const who = await editorSession();
  if ("ok" in who) return who;
  const { workerId, bankCode } = parsed.data;
  try {
    const supabase = await createServerSupabase();
    const { data: worker, error } = await supabase
      .from("workers")
      .select("first_name, last_name, bank_name, bank_code, bank_account_enc")
      .eq("organisation_id", who.organisationId)
      .eq("id", workerId)
      .maybeSingle();
    if (error) throw new Error(`Could not read the employee: ${error.code}`);
    if (!worker) return fail("That employee wasn't found.");
    if (!worker.bank_account_enc)
      return fail("This employee has no bank account on file to check.");
    // The bank is the one on file: its code when saved (slice 2.3b on), otherwise the chosen
    // bank must be the one the saved name means, when it means one.
    const onFile = worker.bank_code ?? bankFromName(worker.bank_name)?.code ?? null;
    if (onFile && onFile !== bankCode && !worker.bank_code) {
      const name = bankByCode(onFile)?.name ?? worker.bank_name;
      return {
        ok: false,
        message: `The bank on file is ${name}. Check with that bank, or raise a bank change if it's wrong.`,
        field: "bankCode",
      };
    }
    const checkCode = worker.bank_code ?? bankCode;
    let number: string;
    try {
      number = decryptPii(
        worker.bank_account_enc,
        bankAccountContext(who.organisationId, workerId),
      );
    } catch (cause) {
      if (cause instanceof PiiDecryptError) {
        return fail("The account number on file can't be read, so it can't be checked.");
      }
      throw cause;
    }
    const result = await runBankLookup({
      organisationId: who.organisationId,
      userId: who.userId,
      purpose: "worker_check",
      workerId,
      bankCode: checkCode,
      accountNumber: number,
      expected: { kind: "person", firstName: worker.first_name, lastName: worker.last_name },
    });
    if (result.ok) {
      await logAuditEvent(supabase, {
        organisationId: who.organisationId,
        action: "people.bank_details_checked",
        entity: "workers",
        entityId: workerId,
        after: { bank_code: result.bankCode, name_check: result.result, test: result.test },
      });
    }
    // Only the name and the comparison go back; never the number.
    return result.ok ? { ...result, lookupId: "" } : result;
  } catch (error) {
    console.error("people.bank_check_failed:", error instanceof Error ? error.name : "unknown");
    return fail(LOOKUP_MESSAGES.failed);
  }
}
