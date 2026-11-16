import type { Metadata } from "next";

import { SoonPage } from "../../_components/soon-page";

export const metadata: Metadata = { title: "My shifts" };

export default function ShiftsPage() {
  return <SoonPage which="shifts" />;
}
