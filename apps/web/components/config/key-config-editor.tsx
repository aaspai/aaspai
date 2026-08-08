"use client";

import { Eye, EyeOff, KeyRound, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface KeyEntry {
  key: string;
  isSet: boolean;
  redactedValue: string | null;
  group: string;
  groupPriority: number;
  info: {
    category: string;
    provider?: string;
    description?: string;
    url?: string;
    password?: boolean;
    custom?: boolean;
  };
}

interface GroupedKey {
  group: string;
  priority: number;
  entries: KeyEntry[];
  configured: number;
}

function groupKeys(keys: KeyEntry[]): GroupedKey[] {
  const map = new Map<string, GroupedKey>();
  for (const entry of keys) {
    const existing = map.get(entry.group) ?? {
      group: entry.group,
      priority: entry.groupPriority,
      entries: [],
      configured: 0,
    };
    existing.entries.push(entry);
    if (entry.isSet) existing.configured += 1;
    map.set(entry.group, existing);
  }
  return [...map.values()].sort(
    (a, b) => a.priority - b.priority || a.group.localeCompare(b.group),
  );
}

export function KeyConfigEditor({ initialKeys }: { initialKeys: KeyEntry[] }) {
  const [keys, setKeys] = useState<KeyEntry[]>(initialKeys);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const grouped = useMemo(() => groupKeys(keys), [keys]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3000);
  }, []);

  const save = async (key: string) => {
    const value = edits[key];
    if (!value) return;
    setSaving(key);
    try {
      const res = await fetch("/api/config/keys", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { redactedValue?: string };
      setKeys((prev) =>
        prev.map((entry) =>
          entry.key === key
            ? { ...entry, isSet: true, redactedValue: data.redactedValue ?? "…" }
            : entry,
        ),
      );
      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      flash(`${key} saved`);
    } catch {
      flash(`Failed to save ${key}`);
    } finally {
      setSaving(null);
    }
  };

  const clear = async (key: string) => {
    setSaving(key);
    try {
      const res = await fetch(`/api/config/keys?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setKeys((prev) =>
        prev.map((entry) =>
          entry.key === key ? { ...entry, isSet: false, redactedValue: null } : entry,
        ),
      );
      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      flash(`${key} cleared`);
    } catch {
      flash(`Failed to clear ${key}`);
    } finally {
      setSaving(null);
    }
  };

  const reveal = async (key: string) => {
    if (revealed[key]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      const res = await fetch("/api/config/keys/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { value: string };
      setRevealed((prev) => ({ ...prev, [key]: data.value }));
    } catch {
      flash(`Failed to reveal ${key}`);
    }
  };

  const addCustom = () => {
    const key = newKey.trim().toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      flash("Invalid key name");
      return;
    }
    setKeys((prev) =>
      prev.some((entry) => entry.key === key)
        ? prev
        : [
            ...prev,
            {
              key,
              isSet: false,
              redactedValue: null,
              group: "Custom",
              groupPriority: 100,
              info: {
                category: "provider",
                provider: "Custom",
                description: "User-added environment variable.",
                password: true,
                custom: true,
              },
            },
          ],
    );
    setEdits((prev) => ({ ...prev, [key]: "" }));
    setNewKey("");
  };

  const renderRow = (entry: KeyEntry) => {
    const isEditing = edits[entry.key] !== undefined;
    const isRevealed = !!revealed[entry.key];
    const display = isRevealed ? revealed[entry.key] : (entry.redactedValue ?? "---");
    return (
      <div key={entry.key} className="flex items-center gap-3 py-1.5 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Label className="font-mono text-xs">{entry.key}</Label>
            {entry.info.custom && (
              <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                custom
              </span>
            )}
          </div>
          {entry.info.description && (
            <p className="truncate text-xs text-muted-foreground">{entry.info.description}</p>
          )}
        </div>

        {isEditing ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              type={entry.info.password ? "password" : "text"}
              value={edits[entry.key]}
              onChange={(e) => setEdits((prev) => ({ ...prev, [entry.key]: e.target.value }))}
              placeholder={entry.isSet ? "New value…" : "Value…"}
              className="h-7 w-44 font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving === entry.key || !edits[entry.key]}
              onClick={() => void save(entry.key)}
              className="h-7 px-2 text-xs"
            >
              <Save className="h-3 w-3" />
              {saving === entry.key ? "…" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setEdits((prev) => {
                  const next = { ...prev };
                  delete next[entry.key];
                  return next;
                })
              }
              className="h-7 px-2 text-xs"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {entry.isSet ? display : "not set"}
            </span>
            {entry.isSet && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                title={isRevealed ? "Hide" : "Reveal"}
                onClick={() => void reveal(entry.key)}
              >
                {isRevealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => setEdits((prev) => ({ ...prev, [entry.key]: "" }))}
            >
              <Pencil className="h-3 w-3" />
              {entry.isSet ? "Replace" : "Set"}
            </Button>
            {entry.isSet && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs text-destructive"
                disabled={saving === entry.key}
                onClick={() => void clear(entry.key)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {notice && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {notice}
        </div>
      )}

      {grouped.map((group) => {
        const isOpen = expanded[group.group] ?? group.configured > 0;
        return (
          <Card key={group.group}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setExpanded((prev) => ({ ...prev, [group.group]: !isOpen }))}
              className={cn(
                "flex w-full items-center justify-between gap-3 p-6 text-left",
                isOpen && "border-b",
              )}
            >
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-sm">{group.group}</CardTitle>
                {group.configured > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {group.configured}/{group.entries.length} set
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {isOpen ? "Hide" : "Show"} {group.entries.length} key
                {group.entries.length === 1 ? "" : "s"}
              </span>
            </button>
            {isOpen && (
              <CardContent className="grid gap-2 divide-y divide-border/60">
                {group.entries.map(renderRow)}
              </CardContent>
            )}
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Plus className="h-4 w-4" /> Add custom key
          </CardTitle>
          <CardDescription>Any environment variable, e.g. a provider API key.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addCustom();
            }}
            placeholder="NEW_API_KEY"
            className="h-8 max-w-xs font-mono text-sm"
          />
          <Button type="button" size="sm" variant="outline" onClick={addCustom}>
            Add
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
