"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import type { ImportPath } from "@/lib/people-import";
import { applyImportFix, cancelImport, commitImport } from "@/server/people/imports/actions";

/** One-click fix on a held row: the button carries the fix the check suggested. */
export function FixButton({
  batchId,
  rowNumber,
  label,
}: {
  batchId: string;
  rowNumber: number;
  label: string;
}) {
  const [state, action, pending] = useActionState(applyImportFix, null);
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="rowNumber" value={rowNumber} />
      <input type="hidden" name="fixLabel" value={label} />
      <Button type="submit" variant="outline" className="h-9 rounded-lg px-3" disabled={pending}>
        {pending ? "Applying…" : label}
      </Button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs font-medium">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/** "Import N employees", with the result or the reason it didn't run. */
export function CommitForm({ batchId, count }: { batchId: string; count: number }) {
  const [state, action, pending] = useActionState(commitImport, null);
  const label =
    count === 0
      ? "Nothing ready to import"
      : `Import ${count} ${count === 1 ? "employee" : "employees"}`;
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="expected" value={count} />
      <Button type="submit" className="h-11 rounded-lg px-5" disabled={pending || count === 0}>
        {pending ? "Importing…" : label}
      </Button>
      {state ? (
        <span
          role={state.ok ? "status" : "alert"}
          className={state.ok ? "text-sm text-fg-muted" : "text-sm font-medium"}
        >
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

/** Drops a batch with nothing imported yet and goes back to the upload. */
export function CancelForm({ batchId, returnTo }: { batchId: string; returnTo: ImportPath }) {
  const [state, action, pending] = useActionState(cancelImport, null);
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <Button type="submit" variant="ghost" className="h-11 rounded-lg px-4" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel this import"}
      </Button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs font-medium">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
