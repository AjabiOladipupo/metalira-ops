import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { moduleName, type ModuleId } from "@/lib/modules";

/** Where owners and admins turn parts of the app on and off (slice 3.0). */
export const MODULES_SETTINGS_HREF = "/app/settings/company#modules";

/**
 * Shown in place of a page whose module the company has switched off (slice 3.0), whether it was
 * reached from an old link or a typed URL. Nothing is deleted while a part is off. Owners and
 * admins get a link to the switches; other roles are told who can turn it on.
 */
export function SwitchedOffPage({ module, canManage }: { module: ModuleId; canManage: boolean }) {
  const name = moduleName(module);
  return (
    <>
      <PageHeader
        back={{ href: "/app", label: "dashboard" }}
        eyebrow={name}
        title="This part is switched off"
        description={`${name} is off for your company. Nothing was deleted: turning it back on shows everything again.`}
      />
      <EmptyState
        message={
          canManage
            ? `Turn ${name} on under Settings, Company, Modules.`
            : `Ask an owner or an admin to turn ${name} on.`
        }
        action={
          canManage ? (
            <Button asChild className="h-11 rounded-lg px-5">
              <Link href={MODULES_SETTINGS_HREF}>Open Modules</Link>
            </Button>
          ) : undefined
        }
      />
    </>
  );
}
