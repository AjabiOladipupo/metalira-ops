import { AppSidebar } from "@/components/shell/app-sidebar";
import { TopBar } from "@/components/shell/top-bar";

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <div className="flex min-h-dvh">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="mx-auto flex w-full max-w-[1240px] flex-col gap-7 px-4 pt-7 pb-12 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
