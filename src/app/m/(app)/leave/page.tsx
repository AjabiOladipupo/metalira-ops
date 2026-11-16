import type { Metadata } from "next";

import { SoonPage } from "../../_components/soon-page";

export const metadata: Metadata = { title: "Leave" };

export default function LeavePage() {
  return <SoonPage which="leave" />;
}
