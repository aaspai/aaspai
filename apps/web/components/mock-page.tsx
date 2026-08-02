"use client";

import {
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Filter,
  MoreHorizontal,
  Search,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ScreenKey =
  | "projects"
  | "inbox"
  | "approvals"
  | "files"
  | "integrations"
  | "automations"
  | "org"
  | "artifacts"
  | "search"
  | "settings";

const screens: Record<
  ScreenKey,
  { eyebrow: string; title: string; description: string; action: string }
> = {
  projects: {
    eyebrow: "Portfolio",
    title: "Projects",
    description: "The workspaces your agents run against.",
    action: "New project",
  },
  inbox: {
    eyebrow: "Attention",
    title: "Inbox",
    description: "The work, decisions, and requests that need a human next.",
    action: "Review all",
  },
  approvals: {
    eyebrow: "Governance",
    title: "Approvals",
    description: "Keep sensitive agent actions reviewable and accountable.",
    action: "View policy",
  },
  files: {
    eyebrow: "Workspace",
    title: "Files",
    description: "Recent outputs, documents, and workspace artifacts.",
    action: "Upload file",
  },
  integrations: {
    eyebrow: "Connect",
    title: "Integrations",
    description: "Tools agents can use, with access and approval boundaries.",
    action: "Add integration",
  },
  automations: {
    eyebrow: "Automate",
    title: "Automations",
    description: "Schedules and triggers that turn intent into repeatable work.",
    action: "New automation",
  },
  org: {
    eyebrow: "Company",
    title: "Organization",
    description: "People, agent roles, and reporting relationships.",
    action: "Add member",
  },
  artifacts: {
    eyebrow: "Outputs",
    title: "Artifacts",
    description: "The durable work your company has produced.",
    action: "Browse outputs",
  },
  search: {
    eyebrow: "Find anything",
    title: "Search",
    description: "Search tasks, agents, files, sessions, and decisions in one place.",
    action: "Search",
  },
  settings: {
    eyebrow: "Control plane",
    title: "Settings",
    description: "Company, runtime, security, and personal preferences.",
    action: "Save changes",
  },
};

const projects = [
  ["Atlas launch", "Research and ship the next product release", "Active", "8 agents", "72%"],
  [
    "Content engine",
    "Turn product knowledge into a weekly publishing loop",
    "Active",
    "4 agents",
    "46%",
  ],
  [
    "Customer intelligence",
    "Keep the company close to customer signals",
    "Paused",
    "2 agents",
    "18%",
  ],
];

const inboxItems = [
  ["CEO", "Approve the Q3 product direction", "Decision", "12 min ago", "High"],
  ["Atlas launch", "Review the first onboarding flow draft", "Review", "34 min ago", "Medium"],
  [
    "Security bot",
    "A connector wants access to production data",
    "Approval",
    "1 hr ago",
    "Critical",
  ],
  ["Content engine", "Weekly report is ready to publish", "Output", "3 hr ago", "Low"],
];

const agents = [
  ["Maya Chen", "Chief of Staff", "Online", "12 tasks", "92%"],
  ["Ravi Shah", "Product Lead", "Working", "8 tasks", "76%"],
  ["Nora Wells", "Researcher", "Idle", "4 tasks", "61%"],
  ["Iris Cole", "Content Manager", "Paused", "2 tasks", "38%"],
];

const integrations = [
  ["GitHub", "Code, issues, pull requests", "Connected", "12 tools"],
  ["Slack", "Team channels and approvals", "Connected", "4 channels"],
  ["Linear", "Product tasks and triage", "Needs review", "8 tools"],
  ["Google Drive", "Documents and source material", "Not connected", "—"],
];

export function MockPage({ screen }: { screen: ScreenKey }) {
  const meta = screens[screen];
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState(screen === "settings" ? "Company" : "All");
  const [saved, setSaved] = useState(false);

  const rows = useMemo(() => {
    const source =
      screen === "projects"
        ? projects
        : screen === "inbox" || screen === "approvals"
          ? inboxItems
          : screen === "org"
            ? agents
            : integrations;
    if (!query.trim()) return source;
    return source.filter((row) => row.join(" ").toLowerCase().includes(query.toLowerCase()));
  }, [query, screen]);

  if (screen === "search") {
    return <SearchScreen query={query} setQuery={setQuery} />;
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {meta.eyebrow}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">{meta.title}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{meta.description}</p>
        </div>
        <Button onClick={() => setSaved(true)}>{saved ? "Saved" : meta.action}</Button>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Active now"
          value={screen === "org" ? "3" : screen === "approvals" ? "4" : "12"}
          detail="Across the company"
          icon={<CircleDot className="h-4 w-4" />}
        />
        <Metric
          label="Needs attention"
          value={screen === "inbox" || screen === "approvals" ? "7" : "3"}
          detail="Since your last visit"
          icon={<Clock3 className="h-4 w-4" />}
        />
        <Metric
          label="Completed this week"
          value="28"
          detail="+18% from last week"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <Metric
          label="Quality signal"
          value="87%"
          detail="Based on reviewed work"
          icon={<Sparkles className="h-4 w-4" />}
        />
      </section>

      {screen === "settings" ? (
        <SettingsScreen
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          saved={saved}
          setSaved={setSaved}
        />
      ) : screen === "files" || screen === "artifacts" || screen === "automations" ? (
        <ResourceGrid screen={screen} />
      ) : (
        <DataScreen screen={screen} rows={rows} query={query} setQuery={setQuery} />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="rounded-md bg-muted p-2 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

function DataScreen({
  screen,
  rows,
  query,
  setQuery,
}: {
  screen: ScreenKey;
  rows: string[][];
  query: string;
  setQuery: (value: string) => void;
}) {
  const labels =
    screen === "projects"
      ? ["Project", "Objective", "Status", "Team", "Progress"]
      : screen === "org"
        ? ["Person", "Role", "Status", "Workload", "Signal"]
        : screen === "integrations"
          ? ["Integration", "Purpose", "State", "Access"]
          : ["Source", "Request", "Type", "Updated", "Priority"];
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>
              {screen === "org"
                ? "People and agents"
                : screen === "integrations"
                  ? "Connected tools"
                  : "Latest"}
            </CardTitle>
            <CardDescription>Realistic mock state for the first product pass.</CardDescription>
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter results"
                className="w-48 pl-8"
              />
            </div>
            <Button variant="outline" size="icon" aria-label="Filter">
              <Filter className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="hidden grid-cols-[1.2fr_1.5fr_0.9fr_0.9fr_0.7fr] gap-4 border-b px-5 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground md:grid">
          {labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <div className="divide-y">
          {rows.map((row) => (
            <div
              key={row.join("-")}
              className="grid gap-3 px-5 py-4 text-sm md:grid-cols-[1.2fr_1.5fr_0.9fr_0.9fr_0.7fr] md:items-center"
            >
              <div className="font-medium">{row[0]}</div>
              <div className="text-muted-foreground">{row[1]}</div>
              <div>
                <Badge
                  variant={
                    row[2] === "Active" ||
                    row[2] === "Connected" ||
                    row[2] === "Online" ||
                    row[2] === "Working"
                      ? "default"
                      : "secondary"
                  }
                >
                  {row[2]}
                </Badge>
              </div>
              <div className="text-muted-foreground">{row[3]}</div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{row[4]}</span>
                <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
          ))}
        </div>
        {rows.length === 0 && (
          <div className="p-10 text-center text-sm text-muted-foreground">No matching results.</div>
        )}
      </CardContent>
    </Card>
  );
}

function ResourceGrid({ screen }: { screen: ScreenKey }) {
  const cards =
    screen === "files" || screen === "artifacts"
      ? [
          ["Launch brief.md", "Document", "Updated 12 min ago"],
          ["Customer interview notes", "Research", "Updated 1 hr ago"],
          ["Q3 operating plan", "Plan", "Updated yesterday"],
          ["Onboarding prototype", "Preview", "Updated 2 days ago"],
        ]
      : [
          ["Daily customer triage", "Schedule", "Every weekday at 09:00"],
          ["Slack escalation", "Webhook", "When #support receives a critical alert"],
          ["Weekly board report", "Routine", "Every Friday at 16:00"],
          ["Research digest", "Schedule", "Every Monday at 08:30"],
        ];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {cards.map(([title, type, detail]) => (
        <Card key={title} className="transition-colors hover:border-foreground/30">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <Badge variant="outline">{type}</Badge>
                <CardTitle className="mt-3 text-lg">{title}</CardTitle>
                <CardDescription className="mt-1">{detail}</CardDescription>
              </div>
              <Button variant="ghost" size="icon" aria-label={`Open ${title}`}>
                <ArrowUpRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
              <span>Owner: Maya Chen</span>
              <span className="flex items-center gap-1">
                <CircleDot className="h-3 w-3 text-emerald-500" /> Ready
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SettingsScreen({
  activeTab,
  setActiveTab,
  saved,
  setSaved,
}: {
  activeTab: string;
  setActiveTab: (value: string) => void;
  saved: boolean;
  setSaved: (value: boolean) => void;
}) {
  const tabs = ["Company", "Runtime", "Security", "Notifications", "Personal"];
  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <Card className="h-fit">
        <CardContent className="space-y-1 p-2">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "w-full rounded-md px-3 py-2 text-left text-sm",
                activeTab === tab
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              {tab}
            </button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{activeTab}</CardTitle>
          <CardDescription>Changes are mocked locally for this frontend slice.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2 text-sm">
            <span className="font-medium">Display name</span>
            <Input
              id="settings-display-name"
              defaultValue={activeTab === "Company" ? "Aaspai Labs" : "Maya Chen"}
            />
          </div>
          <div className="space-y-2 text-sm">
            <span className="font-medium">Description</span>
            <textarea
              id="settings-description"
              className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
              defaultValue="A governed AI workforce that turns company intent into durable work."
            />
          </div>
          <div className="flex items-center justify-between rounded-md border p-4">
            <div>
              <p className="text-sm font-medium">Require approval for sensitive actions</p>
              <p className="text-xs text-muted-foreground">
                Keep external writes and production access reviewable.
              </p>
            </div>
            <button
              type="button"
              aria-label="Toggle approvals"
              onClick={() => setSaved(!saved)}
              className={cn(
                "h-6 w-11 rounded-full p-1 transition-colors",
                saved ? "bg-foreground" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "block h-4 w-4 rounded-full bg-background transition-transform",
                  saved ? "translate-x-5" : "translate-x-0",
                )}
              />
            </button>
          </div>
          <Button onClick={() => setSaved(true)}>{saved ? "Saved" : "Save changes"}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function SearchScreen({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  const results = [
    "Approve the Q3 product direction",
    "Atlas launch onboarding flow",
    "Maya Chen — Chief of Staff",
    "Weekly board report",
    "GitHub connector policy",
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Search everything</CardTitle>
        <CardDescription>Tasks, people, files, sessions, and decisions.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Try ‘Q3’, ‘Maya’, or ‘connector’"
            className="h-10 pl-9"
          />
        </div>
        <div className="space-y-2">
          {results
            .filter((r) => r.toLowerCase().includes(query.toLowerCase()))
            .map((result, index) => (
              <Link
                href={index % 2 ? "/execution" : "/governance"}
                key={result}
                className="flex items-center justify-between rounded-md border px-4 py-3 text-sm hover:bg-accent"
              >
                <span>{result}</span>
                <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
