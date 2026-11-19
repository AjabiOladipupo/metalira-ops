import {
  Activity,
  Banknote,
  Building2,
  CalendarDays,
  CalendarMinus,
  ClipboardCheck,
  FileText,
  FolderKanban,
  House,
  Settings,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import type { NavIcon } from "@/lib/nav";

export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  home: House,
  roster: CalendarDays,
  attendance: Activity,
  timesheets: ClipboardCheck,
  people: Users,
  team: UserCheck,
  leave: CalendarMinus,
  payroll: Wallet,
  clients: Building2,
  projects: FolderKanban,
  unbilled: FileText,
  collections: Banknote,
  revenue: TrendingUp,
  settings: Settings,
};
