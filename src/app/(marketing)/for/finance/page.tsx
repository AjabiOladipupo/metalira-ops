import { RolePage, roleMetadata } from "@/components/marketing/role-page";

export const metadata = roleMetadata("finance");

export default function ForFinancePage() {
  return <RolePage slug="finance" />;
}
