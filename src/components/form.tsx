"use client";

import { useId } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type FieldProps = Omit<React.ComponentProps<"input">, "id" | "size"> & {
  label: string;
  /** Helper line under the input, replaced by the error when there is one. */
  hint?: string;
  error?: string;
  /** Input height: 44px in the manager app (Setup board), 52px in the worker app. */
  inputSize?: "md" | "lg";
};

/** Label above, input, then hint or error below, as on the Setup board. */
export function Field({ label, hint, error, inputSize = "md", className, ...input }: FieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={cn(
          "text-[15px]",
          inputSize === "lg" ? "h-[52px] rounded-lg text-base" : "h-11 rounded-lg",
        )}
        {...input}
      />
      {note ? (
        <p
          id={noteId}
          className={cn("m-0 text-xs", error ? "font-medium text-foreground" : "text-fg-muted")}
        >
          {error}
          {!error && hint}
        </p>
      ) : null}
    </div>
  );
}

/** A form-level message: one sentence, fg text on surface, never red. */
export function FormAlert({ message, className }: { message?: string; className?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className={cn(
        "m-0 rounded-lg border border-foreground bg-surface px-3 py-2.5 text-sm",
        className,
      )}
    >
      {message}
    </p>
  );
}

/** Full-width primary button that shows `pendingLabel` while the form submits. */
export function SubmitButton({
  children,
  pendingLabel,
  size = "md",
  className,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  size?: "md" | "lg";
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className={cn(
        "w-full text-sm",
        size === "lg" ? "h-[52px] rounded-xl text-base" : "h-11 rounded-lg",
        className,
      )}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
