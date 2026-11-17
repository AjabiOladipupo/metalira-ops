import type { Metadata } from "next";

import { workerMessages } from "@/lib/messages/worker";

import { WorkerBrand } from "../_components/worker-brand";
import { WorkerTopBar } from "../_components/worker-top-bar";
import { WorkerSignInForm } from "./worker-sign-in-form";

export const metadata: Metadata = { title: "Staff sign-in" };

const copy = workerMessages.signIn;

/**
 * Worker sign-in: company code, staff ID and 6-digit PIN (slice 1.9). English only, so the
 * board's language picker is hidden (owner decision 16).
 */
export default function WorkerSignInPage() {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 pt-4 pb-8">
      {/* /m sends a signed-out worker back here, so the parent is the public workers page. */}
      <WorkerTopBar back={{ href: "/for/workers", label: workerMessages.back.workersPage }}>
        <WorkerBrand />
      </WorkerTopBar>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 font-display text-[25px] leading-tight font-bold">{copy.title}</h1>
        <p className="m-0 text-[15px] text-fg-muted">{copy.intro}</p>
      </div>
      <WorkerSignInForm />
      <p className="m-0 mt-auto text-center text-sm text-fg-muted">{copy.forgot}</p>
    </main>
  );
}
