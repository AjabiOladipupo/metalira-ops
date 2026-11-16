import type { Metadata } from "next";

import { SoonPage } from "../../_components/soon-page";

export const metadata: Metadata = { title: "Clock" };

export default function ClockPage() {
  return <SoonPage which="clock" />;
}
