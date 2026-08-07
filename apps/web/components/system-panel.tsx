"use client";

import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DaemonStatus {
  pid: number | null;
  running: boolean;
}

interface SystemStatus {
  daemons: {
    worker: DaemonStatus;
    api: DaemonStatus;
  };
  web: { running: boolean };
}

type DaemonKey = keyof SystemStatus["daemons"];

const DAEMON_LABEL: Record<DaemonKey, string> = {
  worker: "Worker",
  api: "API",
};

export function SystemPanel() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [restarting, setRestarting] = useState<DaemonKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/system", { cache: "no-store" });
      if (!res.ok) return;
      setStatus((await res.json()) as SystemStatus);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  const restart = async (target: DaemonKey) => {
    setRestarting(target);
    setNotice(null);
    try {
      const res = await fetch("/api/system/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const data = (await res.json()) as { killed?: boolean; respawned?: boolean; error?: string };
      if (!res.ok) {
        setNotice(data.error ?? `Failed to restart ${target}`);
      } else if (data.killed) {
        setNotice(
          data.respawned
            ? `${DAEMON_LABEL[target]} restarted (respawned).`
            : `${DAEMON_LABEL[target]} signalled — supervisor will respawn it.`,
        );
      } else {
        setNotice(`${DAEMON_LABEL[target]} was not running.`);
      }
    } catch (err) {
      setNotice(`Failed to restart ${target}: ${String(err)}`);
    } finally {
      setRestarting(null);
      void load();
    }
  };

  const renderDaemon = (key: DaemonKey) => {
    const daemon = status?.daemons[key];
    return (
      <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              daemon?.running ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">{DAEMON_LABEL[key]}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {daemon?.running
                ? `pid ${daemon.pid}`
                : daemon?.pid
                  ? `stale pid ${daemon.pid}`
                  : "stopped"}
            </div>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={restarting === key}
          onClick={() => void restart(key)}
          className="shrink-0"
        >
          <RotateCw className={cn("mr-1.5 h-3 w-3", restarting === key && "animate-spin")} />
          {restarting === key ? "Restarting…" : "Restart"}
        </Button>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {renderDaemon("worker")}
        {renderDaemon("api")}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            status?.web.running ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        Web (this dashboard)
      </div>
      {notice && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {notice}
        </div>
      )}
    </div>
  );
}
