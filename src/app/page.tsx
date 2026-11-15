import { APP_NAME } from "@/lib/app";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
      <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
      <p className="text-fg-muted">Setting up. The app shell arrives in the next release.</p>
    </main>
  );
}
