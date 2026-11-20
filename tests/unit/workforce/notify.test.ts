import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, sendEmail } = vi.hoisted(() => ({
  state: {
    inserts: [] as unknown[],
    worker: {} as Record<string, unknown>,
    claim: true,
    rpcArgs: [] as unknown[],
  },
  sendEmail: vi.fn(),
}));

vi.mock("@/server/supabase/admin", () => ({
  createAdminSupabase: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq"]) builder[name] = () => builder;
      builder.insert = (payload: unknown) => {
        state.inserts.push(payload);
        return builder;
      };
      builder.single = async () =>
        table === "inbox_items"
          ? { data: { id: "11111111-1111-4111-8111-111111111111" }, error: null }
          : { data: { ...state.worker, organisations: { name: "Coastline Guards" } }, error: null };
      return builder;
    },
    rpc: async (_name: string, args: unknown) => {
      state.rpcArgs.push(args);
      return { data: state.claim, error: null };
    },
  }),
}));

vi.mock("@/server/email/send", () => ({ sendEmail }));

import { notifyWorker } from "@/server/workforce/notify";

const ORG = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const message = {
  kind: "shift_published",
  title: "Roster published",
  body: "Your shifts are ready.",
};

beforeEach(() => {
  state.inserts = [];
  state.rpcArgs = [];
  state.claim = true;
  state.worker = { first_name: "Musa", email: "musa@example.com", status: "active" };
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ status: "sent", id: "e1" });
});

describe("notifyWorker", () => {
  it("adds the inbox item and emails when the caps allow", async () => {
    const result = await notifyWorker(ORG, WORKER, { ...message, link: "/m/shifts" });
    expect(result).toEqual({ itemId: expect.any(String), email: "sent" });
    expect(state.inserts).toEqual([
      expect.objectContaining({ organisation_id: ORG, worker_id: WORKER, link_path: "/m/shifts" }),
    ]);
    expect(state.rpcArgs).toEqual([expect.objectContaining({ p_org_cap: 30, p_global_cap: 80 })]);
    expect(sendEmail).toHaveBeenCalledOnce();
    const sent = sendEmail.mock.calls[0]![0] as { idempotencyKey: string; subject: string };
    expect(sent.idempotencyKey).toMatch(/^worker-notice\//);
    expect(sent.subject).toBe("Roster published");
  });

  it("keeps the item but skips the email past a cap", async () => {
    state.claim = false;
    expect((await notifyWorker(ORG, WORKER, message)).email).toBe("skipped_cap");
    expect(state.inserts).toHaveLength(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips the email for a worker with no address or who has left, without claiming", async () => {
    state.worker = { first_name: "Musa", email: null, status: "active" };
    expect((await notifyWorker(ORG, WORKER, message)).email).toBe("skipped_no_email");
    state.worker = { first_name: "Musa", email: "musa@example.com", status: "ended" };
    expect((await notifyWorker(ORG, WORKER, message)).email).toBe("skipped_no_email");
    expect(state.rpcArgs).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses an outside link or a web address before writing anything", async () => {
    await expect(
      notifyWorker(ORG, WORKER, { ...message, link: "https://evil.example" }),
    ).rejects.toThrow();
    await expect(
      notifyWorker(ORG, WORKER, { ...message, body: "See www.evil.example" }),
    ).rejects.toThrow();
    await expect(notifyWorker("not-an-id", WORKER, message)).rejects.toThrow();
    expect(state.inserts).toEqual([]);
  });

  it("uses generic wording when the text looks like a web address", async () => {
    await notifyWorker(ORG, WORKER, {
      ...message,
      title: "Pay at acme-pay.com now",
      body: "Visit acme-pay.com",
    });
    const sent = sendEmail.mock.calls[0]![0] as { subject: string };
    expect(sent.subject).toBe("A new message from Coastline Guards");
  });

  it("reports a failed send without throwing", async () => {
    sendEmail.mockRejectedValue(new Error("down"));
    expect((await notifyWorker(ORG, WORKER, message)).email).toBe("failed");
  });
});
