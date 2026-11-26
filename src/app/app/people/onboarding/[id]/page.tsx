import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { formatNaira } from "@/lib/money";
import { ONBOARDING_ROLE_LABELS, ONBOARDING_STATUS_LABELS } from "@/lib/self-onboarding";
import { peoplePageContext } from "@/server/people/page-context";
import { loadOnboardingReview } from "@/server/people/self-onboarding";

import { RouteGate } from "../../../_shell/slots";
import { ApproveOnboardingForm } from "./approve-form";

export const metadata: Metadata = { title: "Review onboarding" };

const masked = (last4: string | null) => (last4 ? `•••• ${last4}` : "Not given");

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-line py-3 first:border-t-0 sm:grid sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className="m-0 text-sm break-words">{value ?? "Not given"}</dd>
    </div>
  );
}

async function Review({ id }: { id: string }) {
  const ctx = await peoplePageContext();
  const review = /^[0-9a-f-]{36}$/.test(id)
    ? await loadOnboardingReview(ctx.supabase, ctx.organisationId, id)
    : null;
  if (!review) notFound();
  const name =
    review.firstName && review.lastName ? `${review.firstName} ${review.lastName}` : review.email;
  return (
    <>
      <PageHeader
        back={{ href: "/app/people/onboarding", label: "Onboard" }}
        eyebrow={`Onboarding · ${ONBOARDING_ROLE_LABELS[review.role]}`}
        title={name}
        description={`${ONBOARDING_STATUS_LABELS[review.status]} · ${review.email}`}
      />
      <section aria-labelledby="sent-details" className="flex flex-col gap-2">
        <h2 id="sent-details" className="m-0 type-h3">
          What they sent
        </h2>
        <dl className="m-0 flex flex-col rounded-xl bg-surface px-4 sm:px-5">
          <Row label="Role (fixed by the invite)" value={ONBOARDING_ROLE_LABELS[review.role]} />
          <Row label="Phone" value={review.phone} />
          {review.onPayroll ? (
            <>
              <Row label="Date of birth" value={review.dateOfBirth} />
              <Row label="Home address" value={review.homeAddress} />
              <Row
                label="Emergency contact"
                value={
                  review.nextOfKinName
                    ? `${review.nextOfKinName}${review.nextOfKinPhone ? ` · ${review.nextOfKinPhone}` : ""}`
                    : null
                }
              />
              <Row label="NIN" value={masked(review.ninLast4)} />
              <Row
                label="Bank"
                value={
                  review.bankName
                    ? `${review.bankName} · ${review.accountName ?? ""} · ${masked(review.bankAccountLast4)}`
                    : null
                }
              />
              <Row label="PFA" value={review.pfaName} />
              <Row label="RSA PIN" value={masked(review.rsaPinLast4)} />
              <Row label="Tax state" value={review.taxState} />
              <Row
                label="NHF"
                value={`${review.nhfOptIn ? "Opted in" : "Not opted in"} · number ${masked(review.nhfNumberLast4)}`}
              />
              <Row
                label="Annual rent declared"
                value={review.annualRentKobo ? formatNaira(BigInt(review.annualRentKobo)) : null}
              />
              <Row
                label="Consent"
                value={`Location: ${review.locationConsent ? "agreed" : "not given"} · Selfie: ${review.selfieConsent ? "agreed" : "not given"}`}
              />
              <Row label="Department" value={review.departmentName} />
            </>
          ) : null}
        </dl>
      </section>
      {review.status === "submitted" ? (
        <ApproveOnboardingForm
          inviteId={review.id}
          onPayroll={review.onPayroll}
          canSetPay={ctx.canEditPay}
          today={ctx.today}
          hasBank={review.bankAccountLast4 !== null}
        />
      ) : null}
    </>
  );
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <RouteGate href="/app/people/onboarding/[id]">
      <Review id={id} />
    </RouteGate>
  );
}
