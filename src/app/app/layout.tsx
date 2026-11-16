import { AppSidebar } from "@/components/shell/app-sidebar";
import { TopBar } from "@/components/shell/top-bar";

import { AccessGate, OrgSwitcherSlot, PlanCardSlot, RoleNav, UserMenuSlot } from "./_shell/slots";

/**
 * Manager shell. The frame is static; the role-filtered nav, company switcher and user menu
 * stream in. Access is checked three times: optimistically in src/proxy.ts, here (signed-in
 * manager) and per page (role may open it). Row-level security checks every query on top.
 */
export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex min-h-dvh">
      <AccessGate />
      <AppSidebar nav={<RoleNav />} planCard={<PlanCardSlot />} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          menuNav={<RoleNav />}
          orgSwitcher={<OrgSwitcherSlot />}
          userMenu={<UserMenuSlot />}
          planCard={<PlanCardSlot />}
        />
        <main className="mx-auto flex w-full max-w-[1240px] flex-col gap-7 px-4 pt-7 pb-12 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
