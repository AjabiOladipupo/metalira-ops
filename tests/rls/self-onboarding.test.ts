/**
 * Slice U.4: self-onboarding invites. The owner or HR invites by email with one role; the invitee
 * sends their details through the server (secret key); owner or HR approves. Proves: the token is
 * single use and expires, another company's token or invite is useless, the invitee can't change
 * the role, nothing is active until approval, self-entered bank details still need a second
 * person, and personal data stays encrypted and out of the audit log.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  createTenantUser,
  createTestUser,
  insertMembershipAsOwner,
  pgClient,
  type Client,
  type TenantUser,
  type TestUser,
} from "./helpers/supabase";

let admin: Client;
let owner: TenantUser;
let other: TenantUser;
let hr: TestUser;
let finance: TestUser;

/** Ciphertext stand-in: the database only stores bytes; the server encrypts in the app. */
const fakeEnc = () => `\\x${randomBytes(48).toString("hex")}`;

const email = (label: string) => `so-${label}-${randomUUID()}@example.test`;

async function invite(
  by: TestUser,
  orgId: string,
  address: string,
  role: string,
  onPayroll = false,
): Promise<{ id: string; token: string }> {
  const { data, error } = await by.client.rpc("create_self_onboarding_invite", {
    p_organisation_id: orgId,
    p_email: address,
    p_role: role,
    p_on_payroll: onPayroll,
  });
  expect(error).toBeNull();
  const row = data![0]!;
  return { id: row.invite_id, token: row.token };
}

function workerDetails(extra: Record<string, unknown> = {}) {
  return {
    first_name: "Musa",
    last_name: "Ibrahim",
    phone: `080${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    date_of_birth: "1994-03-02",
    home_address: "12 Allen Avenue, Ikeja",
    next_of_kin_name: "Aisha Ibrahim",
    next_of_kin_phone: "08091234567",
    nin_enc: fakeEnc(),
    nin_last4: "8901",
    tax_state: "Lagos",
    bank_code: "058",
    bank_name: "GTBank (Guaranty Trust Bank)",
    account_name: "Musa Ibrahim",
    bank_account_enc: fakeEnc(),
    bank_account_last4: "6789",
    bank_account_digest: randomBytes(32).toString("hex"),
    location_consent_version: "1.0",
    ...extra,
  };
}

async function submit(
  token: string,
  details: Record<string, unknown>,
  userId: string | null = null,
) {
  return admin.rpc("submit_self_onboarding", {
    p_token: token,
    p_user_id: userId as string,
    p_details: details as never,
  });
}

async function approveWorker(by: TestUser, orgId: string, inviteId: string) {
  // The server proves the number it re-encrypts is the one sent (its keyed digest).
  const { data: sent } = await admin
    .from("onboarding_invites")
    .select("bank_account_digest")
    .eq("id", inviteId)
    .maybeSingle();
  return by.client.rpc("approve_self_onboarding", {
    p_organisation_id: orgId,
    p_invite_id: inviteId,
    p_worker: {
      id: randomUUID(),
      staff_id: `SO-${randomUUID().slice(0, 8)}`,
      employment_type: "permanent",
      start_date: "2026-11-30",
      nin_enc: fakeEnc(),
      bank_account_digest: sent?.bank_account_digest ?? null,
    },
    p_bank_account_enc: fakeEnc(),
  });
}

beforeAll(async () => {
  admin = adminClient();
  owner = await createTenantUser("so-owner", "Onboarding Org");
  other = await createTenantUser("so-other", "Other Onboarding Org");
  hr = await createTestUser("so-hr", "Hauwa Bello");
  finance = await createTestUser("so-finance", "Femi Ade");
  await insertMembershipAsOwner(owner.orgId, hr.id, "hr");
  await insertMembershipAsOwner(owner.orgId, finance.id, "finance");
});

describe("inviting", () => {
  it("lets the owner and HR invite, not finance, and never as owner or admin", async () => {
    await invite(owner, owner.orgId, email("a"), "guard");
    await invite(owner, owner.orgId, email("b"), "finance");
    await invite(hr, owner.orgId, email("b2"), "cleaner");
    const byFinance = await finance.client.rpc("create_self_onboarding_invite", {
      p_organisation_id: owner.orgId,
      p_email: email("c"),
      p_role: "guard",
    });
    expect(byFinance.error?.code).toBe("42501");
    for (const role of ["admin", "owner", "worker"]) {
      const { error } = await hr.client.rpc("create_self_onboarding_invite", {
        p_organisation_id: owner.orgId,
        p_email: email("d"),
        p_role: role,
      });
      expect(error?.code).toBe("22023");
    }
  });

  it("keeps manager roles for the owner: HR can't invite them (security review H1)", async () => {
    for (const role of ["hr", "finance", "ops_manager", "line_manager"]) {
      const { error } = await hr.client.rpc("create_self_onboarding_invite", {
        p_organisation_id: owner.orgId,
        p_email: email(`hr-${role}`),
        p_role: role,
      });
      expect(error?.code, role).toBe("42501");
    }
    // Nor resend one the owner sent.
    const sent = await invite(owner, owner.orgId, email("ownersent"), "hr");
    const resend = await hr.client.rpc("resend_self_onboarding_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: sent.id,
    });
    expect(resend.error?.code).toBe("42501");
  });

  it("refuses a second open invite for one address and an existing member", async () => {
    const address = email("dup");
    await invite(owner, owner.orgId, address, "guard");
    const again = await owner.client.rpc("create_self_onboarding_invite", {
      p_organisation_id: owner.orgId,
      p_email: address,
      p_role: "cleaner",
    });
    expect(again.error?.code).toBe("MLSO2");
    const member = await owner.client.rpc("create_self_onboarding_invite", {
      p_organisation_id: owner.orgId,
      p_email: hr.email,
      p_role: "finance",
    });
    expect(member.error?.code).toBe("MLSO1");
  });

  it("gives signed-in users no direct writes, and keeps the role fixed even for the database owner", async () => {
    const { id } = await invite(owner, owner.orgId, email("fixed"), "guard");
    const { error } = await owner.client
      .from("onboarding_invites")
      .update({ role: "hr" })
      .eq("id", id);
    expect(error?.code).toBe("42501");
    const db = await pgClient();
    try {
      await expect(
        db.query("update public.onboarding_invites set role = 'hr' where id = $1", [id]),
      ).rejects.toMatchObject({ code: "MLSO8" });
      await expect(
        db.query("delete from public.onboarding_invites where id = $1", [id]),
      ).rejects.toMatchObject({ code: "MLSO8" });
    } finally {
      await db.end();
    }
  });

  it("keeps onboarding.* audit names for the functions", async () => {
    const { error } = await owner.client.rpc("log_audit", {
      p_organisation_id: owner.orgId,
      p_action: "onboarding.approved",
      p_entity: "onboarding_invites",
    });
    expect(error?.code).toBe("42501");
  });

  it("counts today's emails for owner and HR only", async () => {
    const mine = await hr.client.rpc("self_onboarding_emails_sent", {
      p_organisation_id: owner.orgId,
    });
    expect(mine.error).toBeNull();
    const theirs = await finance.client.rpc("self_onboarding_emails_sent", {
      p_organisation_id: owner.orgId,
    });
    expect(theirs.error?.code).toBe("42501");
  });
});

describe("the token", () => {
  it("is for the server only: signed-in and signed-out clients can't look up or submit", async () => {
    const { token } = await invite(owner, owner.orgId, email("srv"), "guard");
    for (const client of [anonClient(), owner.client]) {
      const look = await client.rpc("self_onboarding_lookup", { p_token: token });
      expect(look.error).not.toBeNull();
      const sent = await client.rpc("submit_self_onboarding", {
        p_token: token,
        p_user_id: null as unknown as string,
        p_details: workerDetails() as never,
      });
      expect(sent.error).not.toBeNull();
    }
  });

  it("works once", async () => {
    const { token } = await invite(owner, owner.orgId, email("once"), "guard");
    expect((await submit(token, workerDetails())).error).toBeNull();
    const again = await submit(token, workerDetails());
    expect(again.error?.code).toBe("MLSO3");
    const { data } = await admin.rpc("self_onboarding_lookup", { p_token: token }).single();
    expect(data?.state).toBe("submitted");
  });

  it("expires", async () => {
    const { id, token } = await invite(owner, owner.orgId, email("old"), "guard");
    const db = await pgClient();
    try {
      await db.query(
        "update public.onboarding_invites set expires_at = now() - interval '1 minute', sent_at = now() - interval '8 days' where id = $1",
        [id],
      );
    } finally {
      await db.end();
    }
    const { data } = await admin.rpc("self_onboarding_lookup", { p_token: token }).single();
    expect(data?.state).toBe("expired");
    expect((await submit(token, workerDetails())).error?.code).toBe("MLSO4");
  });

  it("stops working when resent or cancelled", async () => {
    const first = await invite(owner, owner.orgId, email("re"), "cleaner");
    const resent = await owner.client.rpc("resend_self_onboarding_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: first.id,
    });
    expect(resent.error).toBeNull();
    expect((await submit(first.token, workerDetails())).error?.code).toBe("22023");
    const cancel = await owner.client.rpc("cancel_self_onboarding_invite", {
      p_organisation_id: owner.orgId,
      p_invite_id: first.id,
    });
    expect(cancel.error).toBeNull();
    expect((await submit(resent.data![0]!.token, workerDetails())).error?.code).toBe("MLSO5");
  });

  it("from another company reaches nothing here", async () => {
    const theirs = await invite(other, other.orgId, email("theirs"), "guard");
    expect((await submit(theirs.token, workerDetails())).error).toBeNull();
    // Our owner can't read, approve, resend or cancel it, naming either company.
    const { data: rows } = await owner.client
      .from("onboarding_invites")
      .select("id")
      .eq("id", theirs.id);
    expect(rows).toEqual([]);
    for (const org of [owner.orgId, other.orgId]) {
      const approve = await approveWorker(owner, org, theirs.id);
      expect(["P0002", "42501"]).toContain(approve.error?.code);
      const cancel = await owner.client.rpc("cancel_self_onboarding_invite", {
        p_organisation_id: org,
        p_invite_id: theirs.id,
      });
      expect(["P0002", "42501"]).toContain(cancel.error?.code);
    }
  });
});

describe("approval", () => {
  it("creates nothing until approved, then a worker with the invite's role", async () => {
    const address = email("guard");
    const { id, token } = await invite(owner, owner.orgId, address, "guard");
    // The submission names another role and job: both are ignored.
    expect(
      (await submit(token, workerDetails({ role: "owner", job_title: "Owner" }))).error,
    ).toBeNull();
    const before = await admin.from("workers").select("id").eq("email", address);
    expect(before.data).toEqual([]);

    const approved = await approveWorker(hr, owner.orgId, id);
    expect(approved.error).toBeNull();
    const workerId = approved.data![0]!.worker_id;
    const { data: worker } = await admin
      .from("workers")
      .select("job_title, email, status, date_of_birth, home_address, nin_enc")
      .eq("id", workerId)
      .single();
    expect(worker).toMatchObject({
      job_title: "Guard",
      email: address,
      status: "active",
      date_of_birth: "1994-03-02",
      home_address: "12 Allen Avenue, Ikeja",
    });
    expect(worker?.nin_enc).not.toBeNull();
    const { data: consents } = await admin
      .from("worker_consents")
      .select("kind, channel")
      .eq("worker_id", workerId);
    expect(consents).toEqual([{ kind: "location", channel: "onboarding" }]);

    // The invite keeps no personal data once approved, and can't be approved twice.
    const { data: inv } = await admin
      .from("onboarding_invites")
      .select("status, nin_enc, bank_account_enc, phone, home_address")
      .eq("id", id)
      .single();
    expect(inv).toEqual({
      status: "approved",
      nin_enc: null,
      bank_account_enc: null,
      phone: null,
      home_address: null,
    });
    expect((await approveWorker(owner, owner.orgId, id)).error?.code).toBe("MLSO6");
  });

  it("keeps bank details for a second person: the approver can't approve them", async () => {
    const { id, token } = await invite(owner, owner.orgId, email("bank"), "cleaner");
    expect((await submit(token, workerDetails())).error).toBeNull();
    const approved = await approveWorker(owner, owner.orgId, id);
    expect(approved.error).toBeNull();
    const workerId = approved.data![0]!.worker_id;

    const { data: change } = await admin
      .from("bank_detail_changes")
      .select("id, status, requested_by, name_check")
      .eq("worker_id", workerId)
      .single();
    expect(change).toMatchObject({
      status: "pending",
      requested_by: owner.id,
      name_check: "not_checked",
    });
    const { data: workerBank } = await admin
      .from("workers")
      .select("bank_account_enc")
      .eq("id", workerId)
      .single();
    expect(workerBank?.bank_account_enc).toBeNull();

    const self = await owner.client
      .from("bank_detail_changes")
      .update({ status: "approved", decision_note: "Checked the bank letter in person" })
      .eq("id", change!.id)
      .select("id");
    expect(self.error !== null || (self.data ?? []).length === 0).toBe(true);
    const still = await admin
      .from("bank_detail_changes")
      .select("status")
      .eq("id", change!.id)
      .single();
    expect(still.data?.status).toBe("pending");

    const second = await hr.client
      .from("bank_detail_changes")
      .update({ status: "approved", decision_note: "Checked the bank letter in person" })
      .eq("id", change!.id)
      .select("status")
      .single();
    expect(second.error).toBeNull();
    expect(second.data?.status).toBe("approved");
  });

  it("makes a manager a member with the invite's role, only once approved", async () => {
    const person = await createTestUser("so-new-finance", "Ngozi Eze");
    const { id, token } = await invite(owner, owner.orgId, person.email, "finance");

    // Someone else's account can't send it.
    const wrong = await submit(
      token,
      { first_name: "Ngozi", last_name: "Eze", phone: "08031112222", role: "admin" },
      finance.id,
    );
    expect(wrong.error?.code).toBe("MLSO7");
    const stranger = await createTestUser("so-stranger");
    const wrongUser = await submit(
      token,
      { first_name: "Ngozi", last_name: "Eze", phone: "08031112222" },
      stranger.id,
    );
    expect(wrongUser.error?.code).toBe("MLSO7");

    expect(
      (
        await submit(
          token,
          { first_name: "Ngozi", last_name: "Eze", phone: "08031112222", role: "admin" },
          person.id,
        )
      ).error,
    ).toBeNull();
    const none = await admin
      .from("memberships")
      .select("id")
      .eq("user_id", person.id)
      .eq("organisation_id", owner.orgId);
    expect(none.data).toEqual([]);

    // HR can't approve a manager, even one the owner invited (security review H1).
    const byHr = await hr.client.rpc("approve_self_onboarding", {
      p_organisation_id: owner.orgId,
      p_invite_id: id,
    });
    expect(byHr.error?.code).toBe("42501");

    const approved = await owner.client.rpc("approve_self_onboarding", {
      p_organisation_id: owner.orgId,
      p_invite_id: id,
    });
    expect(approved.error).toBeNull();
    const { data: membership } = await admin
      .from("memberships")
      .select("role")
      .eq("user_id", person.id)
      .eq("organisation_id", owner.orgId)
      .single();
    expect(membership?.role).toBe("finance");
  });

  it("lets HR invite and approve a guard on their own", async () => {
    const { id, token } = await invite(hr, owner.orgId, email("hrguard"), "guard");
    expect((await submit(token, workerDetails())).error).toBeNull();
    const approved = await approveWorker(hr, owner.orgId, id);
    expect(approved.error).toBeNull();
    const { data: worker } = await admin
      .from("workers")
      .select("job_title")
      .eq("id", approved.data![0]!.worker_id)
      .single();
    expect(worker?.job_title).toBe("Guard");
  });

  it("refuses ciphertext for another bank account than the one sent (security review L1)", async () => {
    const { id, token } = await invite(owner, owner.orgId, email("swap"), "guard");
    expect((await submit(token, workerDetails())).error).toBeNull();
    const swapped = await owner.client.rpc("approve_self_onboarding", {
      p_organisation_id: owner.orgId,
      p_invite_id: id,
      p_worker: {
        id: randomUUID(),
        staff_id: `SO-${randomUUID().slice(0, 8)}`,
        employment_type: "permanent",
        start_date: "2026-11-30",
        nin_enc: fakeEnc(),
        bank_account_digest: randomBytes(32).toString("hex"),
      },
      p_bank_account_enc: fakeEnc(),
    });
    expect(swapped.error?.code).toBe("22023");
  });

  it("closes submissions nobody decided within 14 days and clears them (security review L4)", async () => {
    const { id, token } = await invite(owner, owner.orgId, email("stale"), "guard");
    expect((await submit(token, workerDetails())).error).toBeNull();
    const db = await pgClient();
    try {
      await db.query(
        "update public.onboarding_invites set submitted_at = now() - interval '15 days' where id = $1",
        [id],
      );
    } finally {
      await db.end();
    }
    const swept = await admin.rpc("expire_self_onboarding_submissions");
    expect(swept.error).toBeNull();
    expect(swept.data).toBeGreaterThanOrEqual(1);
    const { data: inv } = await admin
      .from("onboarding_invites")
      .select("status, nin_enc, bank_account_enc, bank_account_digest")
      .eq("id", id)
      .single();
    expect(inv).toEqual({
      status: "cancelled",
      nin_enc: null,
      bank_account_enc: null,
      bank_account_digest: null,
    });
    const asOwner = await owner.client.rpc("expire_self_onboarding_submissions");
    expect(asOwner.error).not.toBeNull();
  });

  it("is for the owner or HR only", async () => {
    const { id, token } = await invite(owner, owner.orgId, email("fin"), "guard");
    expect((await submit(token, workerDetails())).error).toBeNull();
    expect((await approveWorker(finance, owner.orgId, id)).error?.code).toBe("42501");
  });
});

describe("personal data", () => {
  it("is stored encrypted and never reaches the audit log", async () => {
    const nin = fakeEnc();
    const details = workerDetails({ nin_enc: nin, next_of_kin_name: "Zainab Unique" });
    const { id, token } = await invite(owner, owner.orgId, email("pii"), "supervisor");
    expect((await submit(token, details)).error).toBeNull();
    const { data: stored } = await admin
      .from("onboarding_invites")
      .select("nin_enc")
      .eq("id", id)
      .single();
    expect(stored?.nin_enc).toBe(nin);

    const { data: audit } = await admin
      .from("audit_log")
      .select("action, after, before")
      .eq("organisation_id", owner.orgId)
      .eq("entity", "onboarding_invites");
    expect((audit ?? []).length).toBeGreaterThan(0);
    const text = JSON.stringify(audit);
    for (const secret of [nin.slice(2), "Zainab Unique", details.phone, "12 Allen Avenue"]) {
      expect(text).not.toContain(secret);
    }
    for (const row of audit ?? []) {
      expect(row.action).toMatch(/^onboarding\./);
      for (const key of Object.keys((row.after ?? {}) as object)) {
        expect(["role", "was", "worker_id", "membership_id"]).toContain(key);
      }
    }
  });
});
