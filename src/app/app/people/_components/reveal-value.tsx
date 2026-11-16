"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { PiiField } from "@/lib/mask";
import { revealWorkerPii } from "@/server/people/actions";

const FIELD_NAMES: Record<PiiField, string> = {
  nin: "NIN",
  bank_account: "account number",
  rsa_pin: "RSA PIN",
};

/**
 * A masked personal data value with a Show button for roles allowed to see it in full. The full
 * value is fetched only on request, from the server, which checks the role and writes the
 * reveal to the audit log; it is kept in memory only while shown.
 */
export function RevealValue({
  workerId,
  field,
  masked,
  canReveal,
  testId,
}: {
  workerId: string;
  field: PiiField;
  masked: string;
  canReveal: boolean;
  testId?: string;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function show() {
    setMessage(null);
    startTransition(async () => {
      const result = await revealWorkerPii({ workerId, field });
      if (result.ok) {
        if (result.value === null) setMessage("Nothing on file.");
        else setValue(result.value);
      } else {
        setMessage(result.message);
      }
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono tabular-nums" data-testid={testId}>
        {value ?? masked}
      </span>
      {canReveal ? (
        value === null ? (
          <Button
            variant="link"
            size="sm"
            onClick={show}
            disabled={pending}
            aria-label={`Show ${FIELD_NAMES[field]}`}
          >
            <Eye strokeWidth={1.75} aria-hidden />
            {pending ? "Showing…" : "Show"}
          </Button>
        ) : (
          <Button
            variant="link"
            size="sm"
            onClick={() => setValue(null)}
            aria-label={`Hide ${FIELD_NAMES[field]}`}
          >
            <EyeOff strokeWidth={1.75} aria-hidden />
            Hide
          </Button>
        )
      ) : null}
      {message ? (
        <span role="status" className="text-xs text-fg-muted">
          {message}
        </span>
      ) : null}
    </span>
  );
}
