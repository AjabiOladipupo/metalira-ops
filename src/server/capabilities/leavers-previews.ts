import "server-only";

import { previewAddFinalPayItem, type finalPayItemSchema } from "@/server/payroll/final-pay";
import { previewSetHolidayPay, type holidayPaySchema } from "@/server/payroll/holiday-pay";

import type { PreviewFn } from "./types";

/**
 * Previews for slice 5.9c's money writes: a final-pay item (the worker's net before and after,
 * the exempt and taxable parts) and a new holiday pay multiplier (before and after, from when).
 */

export const previewAddPayrollFinalPayItem: PreviewFn<typeof finalPayItemSchema> = (ctx) =>
  previewAddFinalPayItem(ctx, ctx.data);

export const previewSetPayrollHolidayPay: PreviewFn<typeof holidayPaySchema> = (ctx) =>
  previewSetHolidayPay(ctx, ctx.data);
