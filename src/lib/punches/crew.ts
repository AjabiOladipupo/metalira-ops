import { z } from "zod";

import { OPEN_PUNCH_HOURS } from "./flags";

/**
 * Crew clock-in by a supervisor (slice 3.6): the queue payloads, the crew list's states and the
 * pure rules the checklist follows. Isomorphic, no React.
 *
 * A crew punch is one queue item per "Mark N present" (or clocked out): the item's
 * client_event_id is the batch id, and each worker in it has their own client_event_id, the
 * idempotency key of their punch (unique per worker on the server).
 */

/** At most this many people in one crew punch (the server refuses more). */
export const CREW_MAX = 50;

export const crewEntrySchema = z.object({
  worker_id: z.uuid(),
  client_event_id: z.uuid(),
});

/** One crew punch as the phone queues it (`crew_in` / `crew_out`). */
export const crewPayloadSchema = z.object({
  site_id: z.uuid(),
  entries: z
    .array(crewEntrySchema)
    .min(1)
    .max(CREW_MAX)
    .refine((entries) => new Set(entries.map((e) => e.worker_id)).size === entries.length),
  /** The supervisor's own phone, with their location consent; null without. */
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  accuracy_m: z.number().min(0).max(1_000_000).nullable(),
  has_photo: z.boolean(),
});

export type CrewPayload = z.output<typeof crewPayloadSchema>;

declare module "@/lib/offline/types" {
  interface QueuePayloads {
    crew_in: CrewPayload;
    crew_out: CrewPayload;
  }
}

export const CREW_QUEUE_KINDS = { crew_in: "in", crew_out: "out" } as const;
export type CrewQueueKind = keyof typeof CREW_QUEUE_KINDS;

export function isCrewQueueKind(kind: string): kind is CrewQueueKind {
  return kind === "crew_in" || kind === "crew_out";
}

/** One person on the crew list, as public.my_crew_context gives them. */
export interface CrewMember {
  workerId: string;
  firstName: string;
  lastName: string;
  staffId: string;
  /** Shares a phone or has none (workers.supervisor_clock_in). */
  noPhone: boolean;
  startsAt: string;
  endsAt: string;
  postName: string;
  /** Agreed to photos: a group photo is taken only when everyone in it has. */
  selfieConsent: boolean;
  lastKind: "in" | "out" | null;
  lastAt: string | null;
  lastBySupervisor: boolean;
}

/** Where a person stands now: clocked in (a clock-in from the last 20 hours), out, or neither. */
export type CrewState = "present" | "out" | "none";

export function crewState(member: Pick<CrewMember, "lastKind" | "lastAt">, now: number): CrewState {
  if (!member.lastKind || !member.lastAt) return "none";
  if (now - Date.parse(member.lastAt) >= OPEN_PUNCH_HOURS * 3_600_000) return "none";
  return member.lastKind === "in" ? "present" : "out";
}

export type CrewMode = "in" | "out";

/** Whether the person can be ticked: clock in those not clocked in, clock out those who are. */
export function canMark(
  member: Pick<CrewMember, "lastKind" | "lastAt">,
  mode: CrewMode,
  now: number,
): boolean {
  const state = crewState(member, now);
  return mode === "in" ? state !== "present" : state === "present";
}

/**
 * Who in `selected` hasn't agreed to photos. A group photo shows every face in it (rule 9), so
 * it is offered only when this is empty; the server checks the same.
 */
export function photoBlockers<T extends Pick<CrewMember, "workerId" | "selfieConsent">>(
  members: readonly T[],
  selected: ReadonlySet<string>,
): T[] {
  return members.filter((m) => selected.has(m.workerId) && !m.selfieConsent);
}

/** "Select all" ticks everyone who can be marked; "Clear all" when they already are. */
export function toggleAll(
  members: readonly Pick<CrewMember, "workerId" | "lastKind" | "lastAt">[],
  selected: ReadonlySet<string>,
  mode: CrewMode,
  now: number,
): Set<string> {
  const markable = members.filter((m) => canMark(m, mode, now)).map((m) => m.workerId);
  const allOn = markable.length > 0 && markable.every((id) => selected.has(id));
  return allOn ? new Set() : new Set(markable);
}

/** The first names of the people left unmarked, for the done screen ("Not marked: Ngozi, Sani"). */
export function unmarkedNames(
  members: readonly Pick<CrewMember, "workerId" | "firstName" | "lastKind" | "lastAt">[],
  selected: ReadonlySet<string>,
  mode: CrewMode,
  now: number,
): string[] {
  return members
    .filter((m) => canMark(m, mode, now) && !selected.has(m.workerId))
    .map((m) => m.firstName);
}

/** The queue payload's entries: one new client_event_id per person, in list order. */
export function crewEntries(
  workerIds: readonly string[],
  newId: () => string,
): CrewPayload["entries"] {
  return workerIds.map((workerId) => ({ worker_id: workerId, client_event_id: newId() }));
}
