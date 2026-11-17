import { RolePage, roleMetadata } from "@/components/marketing/role-page";

export const metadata = roleMetadata("workers");

export default function ForWorkersPage() {
  return <RolePage slug="workers" />;
}
