/**
 * Slice U.3 (security review M1): a bulk mapping sends ONE summary per line manager, claimed once
 * under the daily caps with a ref_id fixed by the batch and the manager.
 */
import { describe, expect, it } from "vitest";

import type { MappingSnapshot } from "@/lib/mapping";
import {
  groupByLineManager,
  planSummaries,
  uuidV5,
  type NoticeIo,
} from "@/server/people/bulk-mapping-notices";
import type { SavedMapping } from "@/server/people/mapping";

const ORG = "e0000000-0000-4000-8000-000000000001";
const ACTOR = "d0000000-0000-4000-8000-000000000002";
const SITE = "a0000000-0000-4000-8000-000000000003";

function saved(i: number, lm: string | null, changed = true): SavedMapping {
  const base: MappingSnapshot = {
    department: null,
    lineManager: lm ? { kind: "membership", id: lm, name: "Kola Adebayo" } : null,
    sites: [],
    projects: [],
  };
  return {
    workerId: `w-${i}`,
    organisationId: ORG,
    actorUserId: ACTOR,
    changed,
    lineManagerChanged: false,
    assignmentsChanged: changed,
    effectiveFrom: "2026-11-26",
    before: base,
    after: { ...base, sites: [{ id: SITE, name: "Apapa Gate" }] },
  };
}

function fakeIo(claimAnswers: boolean[] = []) {
  const claims: string[] = [];
  const lookups: string[] = [];
  const io: NoticeIo = {
    contactFor: async (workerId) => {
      lookups.push(workerId);
      return { email: "manager@example.test", name: "Kola Adebayo", userId: "u-manager" };
    },
    claim: async (refId) => {
      claims.push(refId);
      return claimAnswers[claims.length - 1] ?? true;
    },
  };
  return { io, claims, lookups };
}

describe("bulk mapping notices", () => {
  it("40 people sharing one line manager make 1 claim and 1 summary", async () => {
    const people = Array.from({ length: 40 }, (_, i) => saved(i, "m-1"));
    const { io, claims, lookups } = fakeIo();
    const plan = await planSummaries(
      { actorUserId: ACTOR, saved: people, siteId: SITE, batchRef: "batch-1" },
      io,
    );
    expect(claims).toHaveLength(1);
    expect(lookups).toHaveLength(1);
    expect(plan.summaries).toEqual([
      {
        to: { email: "manager@example.test", name: "Kola Adebayo" },
        count: 40,
        siteName: "Apapa Gate",
        appliesFrom: "26 Nov 2026",
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("claims once per line manager with a ref_id fixed by the batch and the manager", async () => {
    const people = [saved(1, "m-1"), saved(2, "m-2"), saved(3, "m-1"), saved(4, null)];
    expect([...groupByLineManager(people).keys()]).toEqual(["membership:m-1", "membership:m-2"]);
    const first = fakeIo();
    const again = fakeIo();
    const mapped = { actorUserId: ACTOR, saved: people, siteId: SITE, batchRef: "batch-1" };
    await planSummaries(mapped, first.io);
    await planSummaries(mapped, again.io);
    expect(first.claims).toHaveLength(2);
    expect(first.claims).toEqual(again.claims);
    expect(first.claims[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const other = fakeIo();
    await planSummaries({ ...mapped, batchRef: "batch-2" }, other.io);
    expect(other.claims[0]).not.toBe(first.claims[0]);
  });

  it("skips the rest once a cap is reached, and lists who wasn't emailed", async () => {
    const people = [saved(1, "m-1"), saved(2, "m-2"), saved(3, "m-2"), saved(4, "m-3")];
    const { io, claims } = fakeIo([true, false]);
    const plan = await planSummaries(
      { actorUserId: ACTOR, saved: people, siteId: SITE, batchRef: "b" },
      io,
    );
    expect(claims).toHaveLength(2);
    expect(plan.summaries).toHaveLength(1);
    expect(plan.skipped.map((s) => s.workerId)).toEqual(["w-2", "w-3", "w-4"]);
  });

  it("tells nobody about unchanged people, or a manager about their own change", async () => {
    const { io, claims } = fakeIo();
    const none = await planSummaries(
      { actorUserId: ACTOR, saved: [saved(1, "m-1", false)], siteId: SITE, batchRef: "b" },
      io,
    );
    expect(none.summaries).toEqual([]);
    const own = await planSummaries(
      { actorUserId: "u-manager", saved: [saved(1, "m-1")], siteId: SITE, batchRef: "b" },
      io,
    );
    expect(own.summaries).toEqual([]);
    expect(claims).toHaveLength(0);
  });

  it("makes RFC 4122 version 5 ids", () => {
    // The same id Python's uuid.uuid5(NAMESPACE_URL, "http://www.example.com/") gives.
    expect(uuidV5("http://www.example.com/")).toBe("fcde3c85-2270-590f-9e7c-ee003d65e0e2");
  });
});
