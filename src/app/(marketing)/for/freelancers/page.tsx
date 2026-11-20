import { RolePage, roleMetadata } from "@/components/marketing/role-page";

export const metadata = roleMetadata("freelancers");

export default function ForFreelancersPage() {
  return <RolePage slug="freelancers" />;
}
