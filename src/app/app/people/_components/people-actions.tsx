import { Send, Upload, UserPlus } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The People header actions: Import (the CSV and Excel import from slice 1.8), Invite (worker
 * invites from slice 1.9) and Add employee. Import and Add employee show to roles that may add
 * employees; Invite to roles that may open the invites page (the same check its RouteGate makes).
 * The pages and actions check the role again.
 */
export function PeopleActions({ canEdit, canInvite }: { canEdit: boolean; canInvite: boolean }) {
  if (!canEdit && !canInvite) return null;
  return (
    <>
      {canEdit ? (
        <Button asChild variant="outline" className="h-10 rounded-lg">
          <Link href="/app/people/import">
            <Upload strokeWidth={1.75} aria-hidden />
            Import
          </Link>
        </Button>
      ) : null}
      {canInvite ? (
        <Button asChild variant="outline" className="h-10 rounded-lg">
          <Link href="/app/people/invites">
            <Send strokeWidth={1.75} aria-hidden />
            Invite
          </Link>
        </Button>
      ) : null}
      {canEdit ? (
        <Button asChild className="h-10 rounded-lg">
          <Link href="/app/people/new">
            <UserPlus strokeWidth={1.75} aria-hidden />
            Add employee
          </Link>
        </Button>
      ) : null}
    </>
  );
}
