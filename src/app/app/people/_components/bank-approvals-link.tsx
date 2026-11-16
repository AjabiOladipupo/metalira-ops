import Link from "next/link";

import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";

import { plural } from "./display";

/**
 * The badge in the People header: how many bank-detail changes wait for a second person. Shown
 * to the roles that can open the approvals list (owner, admin, hr, finance) when any wait.
 */
export function BankApprovalsLink({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Button asChild variant="outline" className="h-10 rounded-lg">
      <Link href="/app/people/approvals" data-testid="bank-approvals-badge">
        <StatusDot tone="action" />
        {plural(count, "bank change", "bank changes")} to approve
      </Link>
    </Button>
  );
}
