"use client";

import { Bot, Database, Home, ListTree, MessagesSquare, ScrollText, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/agents", label: "Agents", icon: ListTree },
  { href: "/sessions", label: "Sessions", icon: ScrollText },
  { href: "/state", label: "State", icon: Database },
];

const secondary = [
  { href: "/chat/agent/ceo", label: "Chat with CEO", icon: MessagesSquare },
  { href: "/settings", label: "Settings", icon: Settings, disabled: true },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r bg-card/50 md:sticky md:top-0 md:flex">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Bot className="h-5 w-5 text-primary" />
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
        <div className="mt-6 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Quick
        </div>
        <ul className="mt-1 space-y-0.5">
          {secondary.map((item) => {
            const active = pathname === item.href;
            const baseClasses = cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              item.disabled
                ? "cursor-not-allowed opacity-50"
                : active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            );
            if (item.disabled) {
              return (
                <li key={item.href}>
                  <div className={baseClasses} title="Coming in v0.2">
                    <item.icon className="h-4 w-4" />
                    {item.label}
                    <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      soon
                    </span>
                  </div>
                </li>
              );
            }
            return (
              <li key={item.href}>
                <Link href={item.href} className={baseClasses}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t p-3 text-[11px] text-muted-foreground">
        <div className="font-medium text-foreground">aaspai</div>
        <div>Self-hosted control plane</div>
        <div className="mt-1 text-muted-foreground/70">AGPL-3.0 · MIT-style</div>
      </div>
    </aside>
  );
}
