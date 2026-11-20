import { z } from "zod";

import { parseHeadcountInput, type HeadcountInput, type HeadcountLine } from "@/lib/headcount";

/**
 * Input for headcount rows (slice 2.5). Flat objects keyed by the form's field names, so
 * `mutate()` puts each message under its field. Every row is read with `parseHeadcountInput`
 * (the same rules the editor's live line uses); the database repeats them (migration
 * 20261119140000_headcount).
 */

const id = (what: string) => z.uuid(`Choose a ${what}`);

const text = (max: number) => z.string().max(max).optional().default("");

const rowFields = z.object({
  contractId: id("contract"),
  siteId: text(64),
  postName: text(200),
  role: text(200),
  band: text(200),
  unit: text(20),
  /** The ticked weekdays (FormData.getAll), "1" to "7". */
  days: z.array(z.string().max(2)).max(14).optional().default([]),
  startTime: text(10),
  endTime: text(10),
  requiredCount: text(10),
  notes: text(2000),
});

export type HeadcountRow = Omit<HeadcountLine, "id">;

function parseRow<T extends z.output<typeof rowFields>>(
  value: T,
  ctx: z.RefinementCtx,
): (Omit<T, keyof HeadcountInput> & HeadcountRow) | typeof z.NEVER {
  const parsed = parseHeadcountInput(value);
  if (!parsed.ok) {
    for (const [field, message] of Object.entries(parsed.errors)) {
      ctx.addIssue({ code: "custom", path: [field], message });
    }
    return z.NEVER;
  }
  return { ...value, ...parsed.line };
}

export const addHeadcountSchema = rowFields.transform(parseRow);

export const updateHeadcountSchema = rowFields
  .extend({ headcountId: id("headcount row") })
  .transform(parseRow);

export const removeHeadcountSchema = z.object({
  contractId: id("contract"),
  headcountId: id("headcount row"),
});

export const contractIdSchema = z.object({ contractId: id("contract") });

export type AddHeadcountInput = z.output<typeof addHeadcountSchema>;
export type UpdateHeadcountInput = z.output<typeof updateHeadcountSchema>;
