import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ChatHost } from "@/components/inbox/chat-host";
import { Sidebar } from "@/components/sidebar";
import { PageHeaderProvider } from "@/contexts/page-header";
import { currentUser } from "@/lib/local-auth";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <div className="flex min-h-screen w-full">
      <Sidebar companyName={user.companyName} founderName={user.name} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1280px] px-6 pb-8 pt-20 md:py-8">
          <PageHeaderProvider>{children}</PageHeaderProvider>
          {/* Persistent chat host: mounted once, toggled by /inbox route so
              conversations and streams survive navigation. */}
          <ChatHost />
        </div>
      </main>
    </div>
  );
}
