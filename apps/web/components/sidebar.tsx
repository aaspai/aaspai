"use client";

import {
  Activity,
  Bot,
  Brain,
  BriefcaseBusiness,
  ClipboardCheck,
  FolderKanban,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Radar,
  Settings,
  Target,
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
  { href: "/", label: "Command center", icon: LayoutDashboard },
  { href: "/inbox", label: "Chats", icon: MessagesSquare },
  { href: "/sessions", label: "Activity", icon: Activity },
  { href: "/observer", label: "Observer", icon: Radar },
  { href: "/company", label: "Company", icon: BriefcaseBusiness },
];

const settingsNav = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/goals", label: "Goals", icon: Target },
  { href: "/issues", label: "Issues", icon: ClipboardCheck },
  { href: "/execution", label: "Work", icon: Activity },
  { href: "/memory", label: "Memory", icon: Brain },
  { href: "/settings", label: "Settings", icon: Settings },
];

const settingsNavLabel = "Settings & configuration";
const primaryNavLabel = "Direct use";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function NavLinkRow({
  item,
  pathname,
  inSheet,
}: {
  item: NavItem;
  pathname: string;
  inSheet?: boolean;
}) {
  const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
  const link = (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      {item.label}
    </Link>
  );
  return <li key={item.href}>{inSheet ? <SheetClose asChild>{link}</SheetClose> : link}</li>;
}

function NavGroup({
  items,
  pathname,
  inSheet,
}: {
  items: NavItem[];
  pathname: string;
  inSheet?: boolean;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <NavLinkRow key={item.href} item={item} pathname={pathname} inSheet={inSheet} />
      ))}
    </ul>
  );
}

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
            <nav className="flex-1 overflow-y-auto py-3">
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {primaryNavLabel}
              </p>
              <NavGroup items={nav} pathname={pathname} inSheet />
              <p className="px-3 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {settingsNavLabel}
              </p>
              <NavGroup items={settingsNav} pathname={pathname} inSheet />
            </nav>
            <SheetClose asChild>
              <Link
                href="/settings"
                className="flex items-center gap-3 rounded-md px-3 py-3 text-sm"
              >
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
          <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {primaryNavLabel}
          </p>
          <NavGroup items={nav} pathname={pathname} />
          <p className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {settingsNavLabel}
          </p>
          <NavGroup items={settingsNav} pathname={pathname} />
        </nav>
        <div className="border-t p-3 text-[11px] text-muted-foreground">
          <Link
            href="/settings"
            className="mb-4 flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent"
          >
            <Settings className="h-4 w-4" /> Settings
          </Link>
          <div className="font-medium text-foreground">{companyName}</div>
          <div className="mt-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted font-semibold text-foreground">
              {founderName.slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-foreground">{founderName}</span>
              <span>Founder</span>
            </span>
          </div>
          <LogoutButton />
        </div>
      </aside>
    </>
  );
}
