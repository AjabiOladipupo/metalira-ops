/**
 * Slice U.4: self-onboarding. The invitee's form rules per role (the same field rules as adding
 * an employee, plus the personal-number check on free text), the role never coming from the
 * submission, and the shared helpers (list status, emails left).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptPii } from "@/server/crypto/pii";
import {
  emailsLeft,
  isManagerOnboardingRole,
  listStatus,
  ONBOARDING_ROLES,
} from "@/lib/self-onboarding";
import { buildSubmission } from "@/server/people/self-onboarding-public";
import {
  approveOnboardingSchema,
  managerOnboardingSchema,
  onboardingInviteSchema,
  workerOnboardingSchema,
} from "@/server/people/self-onboarding-schemas";

const TODAY = "2026-11-25";

const WORKER = {
  confirmEmail: "Musa@Example.com ",
  firstName: "Musa",
  lastName: "Ibrahim",
  phone: "0803 123 4567",
  dateOfBirth: "1994-03-02",
  homeAddress: "12 Allen Avenue, Ikeja",
  nextOfKinName: "Aisha Ibrahim",
  nextOfKinPhone: "08091234567",
  nin: "12345678901",
  bankCode: "058",
  bankAccountNumber: "0123456789",
  accountName: "Musa Ibrahim",
  pfaName: "Stanbic IBTC Pension",
  rsaPin: "pen100012344421",
  taxState: "Lagos",
  nhfOptIn: "true",
  nhfNumber: "NHF-1234",
  annualRentDeclared: "600,000",
  locationConsent: "on",
  selfieConsent: "",
};

describe("worker form (guard, cleaner, supervisor)", () => {
  it("accepts complete details with the create-employee rules", () => {
    const parsed = workerOnboardingSchema(TODAY).parse(WORKER);
    expect(parsed.confirmEmail).toBe("musa@example.com");
    expect(parsed.phone).toBe("08031234567");
    expect(parsed.rsaPin).toBe("PEN100012344421");
    expect(parsed.annualRentDeclared).toBe(60_000_000n);
    expect(parsed.nhfOptIn).toBe(true);
    expect(parsed.locationConsent).toBe(true);
    expect(parsed.selfieConsent).toBe(false);
  });

  it("drops a role in the submission: the role is the invite's", () => {
    const parsed = workerOnboardingSchema(TODAY).parse({ ...WORKER, role: "owner" });
    expect(parsed).not.toHaveProperty("role");
    expect(Object.keys(parsed)).not.toContain("role");
  });

  it("needs date of birth, address and an emergency contact", () => {
    const result = workerOnboardingSchema(TODAY).safeParse({
      ...WORKER,
      dateOfBirth: "",
      homeAddress: "",
      nextOfKinName: "",
      nextOfKinPhone: "",
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path[0]);
    expect(paths).toEqual(
      expect.arrayContaining(["dateOfBirth", "homeAddress", "nextOfKinName", "nextOfKinPhone"]),
    );
  });

  it("refuses bad numbers as create_worker does", () => {
    const result = workerOnboardingSchema(TODAY).safeParse({
      ...WORKER,
      nin: "1234",
      bankAccountNumber: "12345",
      phone: "12345",
    });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(["nin", "bankAccountNumber", "phone"]));
  });

  it("refuses personal numbers in free text", () => {
    for (const field of ["homeAddress", "nextOfKinName", "accountName", "firstName", "pfaName"]) {
      const result = workerOnboardingSchema(TODAY).safeParse({
        ...WORKER,
        [field]: "Musa 1234567890",
      });
      expect(result.success, field).toBe(false);
    }
  });

  it("wants the bank, number and account name together", () => {
    const result = workerOnboardingSchema(TODAY).safeParse({ ...WORKER, accountName: "" });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path[0])).toContain("accountName");
  });

  it("refuses a date of birth in the future", () => {
    const result = workerOnboardingSchema(TODAY).safeParse({
      ...WORKER,
      dateOfBirth: "2030-01-01",
    });
    expect(result.success).toBe(false);
  });
});

describe("manager form (HR, finance, ops manager, line manager)", () => {
  it("needs only name and phone; employee details are optional", () => {
    const parsed = managerOnboardingSchema(TODAY).parse({
      firstName: "Hauwa",
      lastName: "Bello",
      phone: "+2348031234567",
      role: "admin",
    });
    expect(parsed.phone).toBe("08031234567");
    expect(parsed.dateOfBirth).toBeNull();
    expect(parsed).not.toHaveProperty("role");
  });

  it("still checks the employee fields it is given", () => {
    const result = managerOnboardingSchema(TODAY).safeParse({
      firstName: "Hauwa",
      lastName: "Bello",
      phone: "08031234567",
      nin: "999",
    });
    expect(result.success).toBe(false);
  });
});

describe("invite form", () => {
  it("takes one of the seven roles and decodes the line manager", () => {
    const id = randomUUID();
    const parsed = onboardingInviteSchema.parse({
      email: " Musa@Example.com",
      role: "guard",
      lineManager: `w:${id}`,
    });
    expect(parsed).toMatchObject({
      email: "musa@example.com",
      role: "guard",
      lineManagerWorkerId: id,
      lineManagerMembershipId: null,
      onPayroll: false,
    });
  });

  it("never offers owner or admin", () => {
    expect(ONBOARDING_ROLES).not.toContain("owner");
    expect(ONBOARDING_ROLES).not.toContain("admin");
    for (const role of ["owner", "admin", "worker"]) {
      expect(onboardingInviteSchema.safeParse({ email: "a@b.co", role }).success).toBe(false);
    }
  });

  it("maps manager roles to memberships and the rest to workers", () => {
    expect(ONBOARDING_ROLES.filter(isManagerOnboardingRole)).toEqual([
      "hr",
      "finance",
      "ops_manager",
      "line_manager",
    ]);
  });
});

describe("approve form", () => {
  it("checks pay as adding an employee does", () => {
    const id = randomUUID();
    expect(
      approveOnboardingSchema.safeParse({
        inviteId: id,
        startDate: TODAY,
        employmentType: "permanent",
        payType: "monthly",
      }).success,
    ).toBe(false);
    const ok = approveOnboardingSchema.parse({
      inviteId: id,
      startDate: TODAY,
      employmentType: "permanent",
      payType: "daily",
      dailyRate: "7,500",
    });
    expect(ok.dailyRate).toBe(750_000n);
  });
});

describe("shared helpers", () => {
  it("shows an open invite past its date as expired", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    expect(listStatus("sent", "2026-11-25T11:00:00Z", now)).toBe("expired");
    expect(listStatus("opened", "2026-11-26T11:00:00Z", now)).toBe("opened");
    expect(listStatus("submitted", "2026-11-01T11:00:00Z", now)).toBe("submitted");
  });

  it("counts emails left under both caps", () => {
    const caps = { perCompany: 30, overall: 80 };
    expect(emailsLeft({ company: 4, overall: 10 }, caps)).toBe(26);
    expect(emailsLeft({ company: 4, overall: 78 }, caps)).toBe(2);
    expect(emailsLeft({ company: 31, overall: 31 }, caps)).toBe(0);
  });
});

describe("the submission sent to the database", () => {
  beforeEach(() => {
    vi.stubEnv("PII_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("has no role and carries personal numbers only encrypted for the invite row", () => {
    const org = randomUUID();
    const invite = randomUUID();
    const { confirmEmail: _ignored, ...details } = workerOnboardingSchema(TODAY).parse({
      ...WORKER,
      role: "owner",
    });
    void _ignored;
    const sent = buildSubmission(org, invite, details);
    expect(sent).not.toHaveProperty("role");
    const text = JSON.stringify(sent);
    for (const secret of ["12345678901", "0123456789", "PEN100012344421", "NHF-1234"]) {
      expect(text).not.toContain(secret);
    }
    expect(sent.nin_last4).toBe("8901");
    expect(sent.bank_account_last4).toBe("6789");
    expect(sent.bank_name).toBe("GTBank (Guaranty Trust Bank)");
    expect(
      decryptPii(sent.nin_enc as string, {
        organisationId: org,
        table: "onboarding_invites",
        column: "nin_enc",
        rowId: invite,
      }),
    ).toBe("12345678901");
    expect(sent.location_consent_version).toBe("1.0");
    expect(sent).not.toHaveProperty("selfie_consent_version");
  });
});
