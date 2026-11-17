import { RolePage, roleMetadata } from "@/components/marketing/role-page";

export const metadata = roleMetadata("owners");

export default function ForOwnersPage() {
  return <RolePage slug="owners" />;
}
