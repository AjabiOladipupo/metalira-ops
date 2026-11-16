import { Upload, UserPlus } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The People header actions: Import (the CSV and Excel import from slice 1.8) and Add employee.
 * Only roles that may add employees (owner, admin, hr) see them; the pages and actions check the
 * role again.
 */
export function PeopleActions({ canEdit }: { canEdit: boolean }) {
  if (!canEdit) return null;
  return (
    <>
      <Button asChild variant="outline" className="h-10 rounded-lg">
        <Link href="/app/people/import">
          <Upload strokeWidth={1.75} aria-hidden />
          Import
        </Link>
      </Button>
      <Button asChild className="h-10 rounded-lg">
        <Link href="/app/people/new">
          <UserPlus strokeWidth={1.75} aria-hidden />
          Add employee
        </Link>
      </Button>
    </>
  );
}
