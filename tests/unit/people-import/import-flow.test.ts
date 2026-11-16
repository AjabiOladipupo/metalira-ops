/**
 * Slice 1.8: storing checked rows and building the commit, without a database. Personal data
 * leaves the validator's rows encrypted for the import row, comes back exactly for a re-check,
 * and is encrypted again for the new worker at commit. A stored batch checks again to the same
 * result as the file.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { decryptPii } from "@/server/crypto/pii";
import {
  validateImportRecords,
  validatePeopleImport,
  type ImportResult,
  type RowResult,
} from "@/server/people/import";
import {
  RAW_COLUMNS,
  buildCommitPayload,
  recordFromStored,
  toRowDoc,
  type ImportRowDoc,
  type StoredImportRow,
} from "@/server/people/imports/rows";
import {
  PROBLEMS_HEADER,
  importProblemsCsv,
  importTemplateCsv,
  problemsFileName,
} from "@/server/people/imports/downloads";

const ORG = "6f0c1f51-3c2b-4c5e-9d38-0d6a3b2f4a11";
let counter = 0;
const nextId = () => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));

type Checked = Extract<ImportResult, { ok: true }>;
let checked: Checked;

beforeAll(async () => {
  // A throwaway key: never a real one.
  vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  const bytes = new Uint8Array(readFileSync(fixture("people-import-162.csv")));
  const result = await validatePeopleImport({ name: "people-import-162.csv", bytes }, {});
  if (!result.ok) throw new Error("fixture did not validate");
  checked = result;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function row(rowNumber: number): RowResult {
  const found = checked.rows.find((r) => r.rowNumber === rowNumber);
  if (!found) throw new Error(`row ${rowNumber} missing`);
  return found;
}

/** What the database would hand back for a stored doc. */
function stored(doc: ImportRowDoc): StoredImportRow {
  return {
    id: doc.id,
    row_number: doc.row_number,
    raw: doc.raw,
    nin_enc: doc.nin_enc,
    bank_account_enc: doc.bank_account_enc,
    rsa_pin_enc: doc.rsa_pin_enc,
    numeric_columns: doc.numeric_columns,
    extra_values: doc.extra_values,
    fixes: doc.fixes,
  };
}

describe("storing a checked row", () => {
  it("keeps NIN, bank account number and RSA PIN out of raw and normalised", () => {
    const source = row(3); // AFS-0002 has a NIN, an account number and an RSA PIN.
    expect(source.raw.nin).not.toBe("");
    const doc = toRowDoc(ORG, nextId(), source, []);
    expect(Object.keys(doc.raw).sort()).toEqual([...RAW_COLUMNS].sort());
    expect(doc.raw).not.toHaveProperty("nin");
    expect(doc.raw).not.toHaveProperty("bank_account_number");
    expect(doc.raw).not.toHaveProperty("rsa_pin");

    const text = JSON.stringify(doc);
    for (const secret of [source.raw.nin, source.raw.bank_account_number, source.raw.rsa_pin]) {
      expect(text).not.toContain(secret);
    }
    const worker = (doc.normalised as { worker: Record<string, unknown> }).worker;
    expect(worker).not.toHaveProperty("nin");
    expect(worker).not.toHaveProperty("bankAccountNumber");
    expect(worker).not.toHaveProperty("rsaPin");
    expect(worker).toMatchObject({ hasNin: true, hasBankAccount: true, hasRsaPin: true });
  });

  it("encrypts personal data for the import row, column and organisation", () => {
    const source = row(3);
    const id = nextId();
    const doc = toRowDoc(ORG, id, source, []);
    const ctx = (column: string) => ({
      organisationId: ORG,
      table: "import_rows",
      column,
      rowId: id,
    });
    expect(decryptPii(doc.nin_enc!, ctx("nin_enc"))).toBe(source.raw.nin);
    expect(decryptPii(doc.bank_account_enc!, ctx("bank_account_enc"))).toBe(
      source.raw.bank_account_number,
    );
    expect(decryptPii(doc.rsa_pin_enc!, ctx("rsa_pin_enc"))).toBe(source.raw.rsa_pin);
    // Bound to its row: another row id does not decrypt.
    expect(() => decryptPii(doc.nin_enc!, { ...ctx("nin_enc"), rowId: nextId() })).toThrow();
  });

  it("stores amounts as strings of whole kobo and maps statuses", () => {
    const doc = toRowDoc(ORG, nextId(), row(2), []);
    const rate = (doc.normalised as { payRate: Record<string, unknown> }).payRate;
    expect(rate.basicKobo).toBe("45000000");
    expect(typeof rate.basicKobo).toBe("string");
    expect(doc.status).toBe("ready");
    expect(toRowDoc(ORG, nextId(), row(23), []).status).toBe("held");
    expect(toRowDoc(ORG, nextId(), row(88), []).status).toBe("ready");
    expect(toRowDoc(ORG, nextId(), row(88), []).attention).toBe(true);
    expect(toRowDoc(ORG, nextId(), row(2), [{ label: "x", at: "" }]).status).toBe("fixed");
  });

  it("keeps a fix's label but not its patch values", () => {
    const doc = toRowDoc(ORG, nextId(), row(57), []);
    expect(doc.errors).toEqual([
      expect.objectContaining({
        code: "bank_account_invalid",
        fix: { label: "Mark for HR to fix" },
      }),
    ]);
  });
});

describe("checking a stored batch again", () => {
  it("gives the same result as the file", () => {
    const docs = checked.rows.map((r) => toRowDoc(ORG, nextId(), r, []));
    const records = docs.map((doc) => recordFromStored(ORG, stored(doc)));
    const again = validateImportRecords(records, checked.columns.present, {}, { format: "csv" });
    if (!again.ok) throw new Error("re-check failed");
    expect(again.summary).toEqual(checked.summary);
    expect(again.rows.map((r) => [r.rowNumber, r.status, r.problems, r.warnings])).toEqual(
      checked.rows.map((r) => [r.rowNumber, r.status, r.problems, r.warnings]),
    );
  });

  it("applies a one-click fix on top of the stored cells", () => {
    const docs = checked.rows.map((r) => toRowDoc(ORG, nextId(), r, []));
    const fix = row(140).problems[0]?.fix;
    expect(fix?.label).toBe("Match to Coastline Logistics");
    const records = docs.map((doc) =>
      recordFromStored(ORG, stored(doc), doc.row_number === 140 ? fix!.patch : {}),
    );
    const again = validateImportRecords(records, checked.columns.present, {}, { format: "csv" });
    if (!again.ok) throw new Error("re-check failed");
    expect(again.summary.importable).toBe(160);
    expect(again.summary.held).toBe(2);
  });

  it("still suggests the line manager once the other rows are in the account", () => {
    // The account after importing every row that imports: workers with their department,
    // site and client, and those records themselves.
    const departments = new Map<string, string>();
    const clients = new Map<string, string>();
    const sites = new Map<string, { id: string; clientId: string; name: string }>();
    const projects = new Map<string, { id: string; clientId: string; name: string }>();
    const idFor = <T>(map: Map<string, T>, key: string, make: (id: string) => T) => {
      if (!map.has(key)) map.set(key, make(`${map.size + 1}-${key}`));
      return map.get(key)!;
    };
    const existingWorkers = checked.rows.flatMap((r) => {
      const n = r.normalised;
      if (!n) return [];
      const departmentId = idFor(departments, n.department.name, (id) => id);
      const client = n.mapping.client;
      const clientId = client ? idFor(clients, client.name, (id) => id) : null;
      const site =
        client && clientId && n.mapping.site
          ? idFor(sites, `${client.name}|${n.mapping.site.name}`, (id) => ({
              id,
              clientId,
              name: n.mapping.site!.name,
            }))
          : null;
      if (client && clientId && n.mapping.project) {
        idFor(projects, `${client.name}|${n.mapping.project.name}`, (id) => ({
          id,
          clientId,
          name: n.mapping.project!.name,
        }));
      }
      const ref = n.lineManager;
      return [
        {
          id: `w-${n.worker.staffId}`,
          staffId: n.worker.staffId,
          firstName: n.worker.firstName,
          lastName: n.worker.lastName,
          phone: n.worker.phone,
          lineManagerStaffId: ref && ref.kind !== "membership" ? ref.staffId : null,
          departmentId,
          siteId: site?.id ?? null,
          clientId,
        },
      ];
    });
    const context = {
      existingWorkers,
      departments: [...departments].map(([name, id]) => ({ id, name })),
      clients: [...clients].map(([name, id]) => ({ id, name })),
      sites: [...sites.values()],
      projects: [...projects.values()],
    };
    const held = checked.rows
      .filter((r) => r.status === "held")
      .map((r) => recordFromStored(ORG, stored(toRowDoc(ORG, nextId(), r, []))));
    const again = validateImportRecords(held, checked.columns.present, context, { format: "csv" });
    if (!again.ok) throw new Error("re-check failed");
    const row23 = again.rows.find((r) => r.rowNumber === 23);
    expect(row23?.problems).toEqual([
      expect.objectContaining({
        code: "line_manager_unknown",
        fix: { label: "Set to Kola Adebayo", patch: { line_manager_employee_id: "AFS-0003" } },
      }),
    ]);
  });
});

describe("the commit payload", () => {
  const ids = () => {
    let n = 0;
    return () => {
      n += 1;
      return `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    };
  };

  it("sends only rows that import, managers before their reportees", () => {
    const payload = buildCommitPayload(
      ORG,
      checked.rows.map((r) => ({ rowId: nextId(), result: r })),
      ids(),
    );
    expect(payload).toHaveLength(159);
    const position = new Map(payload.map((item, index) => [item.worker.id as string, index]));
    for (const [index, item] of payload.entries()) {
      const manager = item.line_manager;
      if (manager && "worker_id" in manager) {
        const at = position.get(manager.worker_id);
        expect(at, `manager of ${String(item.worker.staff_id)}`).toBeDefined();
        expect(at!).toBeLessThan(index);
      }
    }
    expect(payload.map((item) => item.worker.staff_id)).not.toContain("AFS-0022"); // row 23, held
  });

  it("encrypts personal data again for the new worker and keeps kobo as strings", () => {
    const source = row(3);
    const [item] = buildCommitPayload(ORG, [{ rowId: nextId(), result: source }], ids());
    expect(item).toBeDefined();
    const workerId = item!.worker.id as string;
    const ctx = (column: string) => ({
      organisationId: ORG,
      table: "workers",
      column,
      rowId: workerId,
    });
    expect(decryptPii(item!.worker.nin_enc as string, ctx("nin_enc"))).toBe(source.raw.nin);
    expect(decryptPii(item!.worker.bank_account_enc as string, ctx("bank_account_enc"))).toBe(
      source.raw.bank_account_number,
    );
    expect(item!.worker.bank_account_last4).toBe(source.raw.bank_account_number.slice(-4));
    expect(item!.pay_rate).toMatchObject({ pay_type: "monthly", basic_kobo: "38000000" });
    expect(item!.department).toEqual({ name: "Head office" });
    expect(JSON.stringify(item)).not.toContain(source.raw.nin);
  });

  it("marks the repeated phone for supervisor clock-in and imports rows without pay", () => {
    const payload = buildCommitPayload(
      ORG,
      checked.rows.map((r) => ({ rowId: nextId(), result: r })),
      ids(),
    );
    const byStaff = new Map(payload.map((item) => [item.worker.staff_id, item]));
    const row88 = byStaff.get(row(88).normalised!.worker.staffId);
    expect(row88?.worker.supervisor_clock_in).toBe(true);
    const noPay = checked.rows.filter((r) => r.normalised?.worker.needsPayDetails);
    expect(noPay.length).toBe(3);
    for (const r of noPay) {
      const item = byStaff.get(r.normalised!.worker.staffId);
      expect(item).toBeDefined();
      if (!r.normalised!.payRate) expect(item!.pay_rate).toBeNull();
    }
  });
});

describe("downloads", () => {
  it("serves the template's 32 columns", () => {
    const header = readFileSync(fixture("employee_import_template.csv"), "utf8").split(/\r?\n/)[0];
    expect(importTemplateCsv()).toBe(`﻿${header}\r\n`);
  });

  it("lists problems and escapes formula cells", () => {
    const csv = importProblemsCsv([
      {
        rowNumber: 23,
        staffId: "=1+1",
        name: "Ada Obi",
        status: "held",
        problems: [
          {
            message: "Line manager ID MO-0090 is not in the file.",
            fixLabel: "Set to Kola Adebayo",
          },
        ],
        warnings: [],
      },
      {
        rowNumber: 88,
        staffId: "AFS-0087",
        name: "Bayo Ade",
        status: "ready",
        problems: [],
        warnings: [
          {
            message: "Phone 0803 ••• 1120 is also on row 12.",
            appliedFix: "Use supervisor clock-in",
          },
        ],
      },
    ]);
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe(PROBLEMS_HEADER.join(","));
    expect(lines[1]).toBe(
      "23,'=1+1,Ada Obi,Held back,Line manager ID MO-0090 is not in the file.,Set to Kola Adebayo",
    );
    expect(lines[2]).toBe(
      "88,AFS-0087,Bayo Ade,Imports with the fix applied,Phone 0803 ••• 1120 is also on row 12.,Use supervisor clock-in",
    );
  });

  it("names the problems file after the upload", () => {
    expect(problemsFileName("employees_oct.xlsx")).toBe("employees_oct-problems.csv");
    expect(problemsFileName('a"b\r\n.csv')).toBe("a-b-problems.csv");
  });
});
