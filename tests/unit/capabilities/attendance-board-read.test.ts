/**
 * Slice 3.7 security review L1: the ops agent's read of the live board never carries a phone
 * number, neither in full nor its last four digits.
 */
import { describe, expect, it } from "vitest";

import { findCapability } from "@/server/capabilities/registry";

const row = {
  assignment_id: "00000000-0000-4000-8000-000000000001",
  shift_date: "2026-11-21",
  starts_at: "2026-11-21T05:00:00+00:00",
  ends_at: "2026-11-21T17:00:00+00:00",
  site_id: "00000000-0000-4000-8000-000000000002",
  site_name: "Apapa Warehouse 3",
  post_id: "00000000-0000-4000-8000-000000000003",
  post_name: "Gate A · Day",
  worker_id: "00000000-0000-4000-8000-000000000004",
  worker_name: "Daniel Okon",
  staff_id: "EMP-0001",
  phone: "08031234410",
  phone_last4: "4410",
  published: true,
  first_in_at: null,
  last_punch_kind: null,
  last_punch_at: null,
  punch_flags: [],
  by_supervisor: false,
  status: "late",
  late_minutes: 22,
  site_last_sync_at: null,
  site_late_syncs: 0,
  board_at: "2026-11-21T05:22:00+00:00",
  late_grace_minutes: 10,
  no_show_after_minutes: 60,
  time_zone: "Africa/Lagos",
};

describe("attendance.live_board for the agent", () => {
  it("strips the phone number and its last four digits", async () => {
    const capability = findCapability("attendance.live_board");
    expect(capability?.read).toBeTypeOf("function");
    const supabase = { rpc: async () => ({ data: [row], error: null }) };
    const board = (await capability!.read!({ supabase, organisationId: row.site_id } as never, {
      organisationId: row.site_id,
    })) as { rows: Record<string, unknown>[] };
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      workerName: "Daniel Okon",
      phone: null,
      phoneLast4: null,
    });
    expect(JSON.stringify(board)).not.toContain("4410");
  });
});
