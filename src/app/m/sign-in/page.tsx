import type { Metadata } from "next";

import { LogoMark } from "@/components/logo";

import { WorkerSignInForm } from "./worker-sign-in-form";

export const metadata: Metadata = { title: "Staff sign-in" };

/** Worker sign-in (company code, staff ID, PIN). Design only in Phase 0; Phase 1 wires it up. */
export default function WorkerSignInPage() {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 pt-4 pb-8">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <LogoMark size={24} />
          <span className="font-display text-base font-medium">
            Metalira <b className="font-bold">Ops</b>
          </span>
        </span>
        <label className="flex">
          <span className="sr-only">Language</span>
          <select
            disabled
            defaultValue="en"
            title="More languages arrive later"
            className="h-10 rounded-lg border border-line bg-background px-2 text-sm font-medium text-foreground disabled:opacity-60"
          >
            <option value="en">English</option>
            <option value="pcm">Pidgin</option>
            <option value="yo">Yorùbá</option>
            <option value="ha">Hausa</option>
          </select>
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 font-display text-[25px] leading-tight font-bold">Sign in</h1>
        <p className="m-0 text-[15px] text-fg-muted">
          Use the company code and staff ID on your invite, and your PIN.
        </p>
      </div>
      <WorkerSignInForm />
      <p className="m-0 mt-auto text-center text-sm text-fg-muted">
        Forgot your PIN? Ask your supervisor.
      </p>
    </main>
  );
}
