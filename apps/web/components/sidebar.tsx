"use client";

import {
  Activity,
  Bot,
  BriefcaseBusiness,
  ClipboardCheck,
  Menu,
  Settings,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/company", label: "Company", icon: BriefcaseBusiness },
  { href: "/governance", label: "Decisions", icon: ClipboardCheck },
  { href: "/execution", label: "Work", icon: Activity },
  { href: "/agents", label: "Team", icon: Users },
  { href: "/sessions", label: "Activity", icon: Activity },
];

export function Sidebar({
  companyName,
  founderName,
}: {
  companyName: string;
  founderName: string;
}) {
  const pathname = usePathname();
  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b bg-background px-4 md:hidden">
        <span className="flex items-center gap-2 font-semibold">
          <Bot className="h-5 w-5" />
          aaspai
        </span>
        <Sheet>
          <SheetTrigger asChild>
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-md border"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="flex flex-col p-4">
            <SheetHeader className="border-b pb-4 text-left">
              <SheetTitle>{companyName}</SheetTitle>
            </SheetHeader>
            <nav className="flex-1 py-3">
              <ul className="space-y-1">
                {nav.map((item) => (
                  <li key={item.href}>
                    <SheetClose asChild>
                      <Link
                        href={item.href}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-3 text-sm",
                          pathname === item.href || pathname?.startsWith(`${item.href}/`)
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    </SheetClose>
                  </li>
                ))}
              </ul>
            </nav>
            <SheetClose asChild>
              <Link href="/setup" className="flex items-center gap-3 rounded-md px-3 py-3 text-sm">
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </SheetClose>
            <div className="border-t pt-4 text-sm">
              <p className="font-medium">{founderName}</p>
              <p className="text-xs text-muted-foreground">Founder</p>
              <LogoutButton />
            </div>
          </SheetContent>
        </Sheet>
      </header>
      <aside className="hidden h-screen w-60 shrink-0 flex-col border-r bg-card/50 md:sticky md:top-0 md:flex">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Bot className="h-5 w-5" />
          <span className="font-semibold tracking-tight">aaspai</span>
          <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            v0.1
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          <ul className="space-y-0.5">
            {nav.map((item) => {
              const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-t p-3 text-[11px] text-muted-foreground">
          <Link
            href="/setup"
            className="mb-4 flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent"
          >
            <Settings className="h-4 w-4" /> Settings
          </Link>
          <div className="font-medium text-foreground">{companyName}</div>
          <div className="mt-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted font-semibold text-foreground">
              {founderName.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <span className="font-medium text-foreground">{founderName}</span>
              <br />
              Founder
            </span>
          </div>
          <LogoutButton />
        </div>
      </aside>
    </>
  );
}
