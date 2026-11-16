import { LogoMark } from "@/components/logo";

/** The logo and wordmark at the top of signed-out worker screens. */
export function WorkerBrand() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark size={24} />
      <span className="font-display text-base font-medium">
        Metalira <b className="font-bold">Ops</b>
      </span>
    </span>
  );
}
