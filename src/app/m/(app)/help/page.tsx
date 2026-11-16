import type { Metadata } from "next";

import { SoonPage } from "../../_components/soon-page";

export const metadata: Metadata = { title: "Help" };

export default function HelpPage() {
  return <SoonPage which="help" />;
}
