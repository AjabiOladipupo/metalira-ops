import type { Metadata } from "next";

import { SoonPage } from "../../_components/soon-page";

export const metadata: Metadata = { title: "Payslips" };

export default function PayslipsPage() {
  return <SoonPage which="payslips" />;
}
