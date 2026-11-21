import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { APP_HOME_PATH, WORKER_HOME_PATH, WORKER_SIGN_IN_PATH } from "@/lib/auth/routes";
import { workerMessages } from "@/lib/messages/worker";
import { loadCrewContext, type CrewContext } from "@/server/workforce/crew-data";
import { lookupCrewPageSession } from "@/server/workforce/crew-session";

import { CrewFlow } from "../../_components/crew/crew-flow";
import { WorkerTopBar } from "../../_components/worker-top-bar";

export const metadata: Metadata = { title: "Clock in crew" };

const copy = workerMessages.crew;

function Blocked({ back, line }: { back: { href: string; label: string }; line: string }) {
  return (
    <>
      <div className="px-4 pt-3 pb-1">
        <WorkerTopBar back={back}>
          <h1 className="m-0 font-display text-xl font-bold">{copy.titleIn}</h1>
        </WorkerTopBar>
      </div>
      <p className="m-0 px-4 pt-4 text-base" data-testid="crew-blocked">
        {line}
      </p>
    </>
  );
}

async function Crew() {
  const lookup = await lookupCrewPageSession();
  if (lookup.type === "signed_out") redirect(WORKER_SIGN_IN_PATH);
  const back =
    lookup.type === "crew" && lookup.session.kind === "line_manager"
      ? { href: APP_HOME_PATH, label: "Metalira Ops" }
      : { href: WORKER_HOME_PATH, label: workerMessages.back.home };
  if (lookup.type !== "crew") return <Blocked back={back} line={copy.notSupervisor} />;

  let ctx: CrewContext;
  try {
    ctx = await loadCrewContext(lookup.session.supabase, lookup.session.organisationId);
  } catch {
    return <Blocked back={back} line={copy.notSupervisor} />;
  }
  if (ctx.left) return <Blocked back={back} line={copy.left} />;
  if (!ctx.shiftsEnabled) return <Blocked back={back} line={copy.shiftsOff} />;
  if (ctx.crewSize === 0) return <Blocked back={back} line={copy.notSupervisor} />;
  if (ctx.sites.length === 0) {
    return <Blocked back={back} line={ctx.actorKind === "worker" ? copy.notOnShift : copy.empty} />;
  }
  return <CrewFlow back={back} locationConsent={ctx.locationConsent} sites={ctx.sites} />;
}

/**
 * Crew clock-in (slice 3.6, SupCrew board): a worker-supervisor on shift, or a line manager,
 * ticks the crew on shift at the site and marks them present or clocked out, with an optional
 * group photo. Every crew punch goes through the offline queue.
 */
export default function CrewPage() {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={<span aria-hidden className="m-4 block h-96 rounded-xl bg-surface" />}>
        <Crew />
      </Suspense>
    </main>
  );
}
