import Link from "next/link";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/app";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <Logo size={32} />
      <div className="flex flex-col gap-2">
        <h1 className="sr-only m-0 type-h1">{APP_NAME}</h1>
        <p className="m-0 type-h2">Every shift, accounted for.</p>
        <p className="m-0 type-body-lg text-fg-muted">
          Rosters, attendance, payroll, invoices and margin in one record.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild>
          <Link href="/sign-up">Create an account</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </div>
      <Link href="/design-system" className="text-sm">
        Design system
      </Link>
    </main>
  );
}
