import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/sidebar";
import { currentUser } from "@/lib/local-auth";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <div className="flex min-h-screen w-full">
      <Sidebar companyName={user.companyName} founderName={user.name} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1280px] px-6 pb-8 pt-20 md:py-8">{children}</div>
      </main>
    </div>
  );
}
