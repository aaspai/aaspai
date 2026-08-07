"use client";

import { useCallback, useEffect, useState } from "react";
import { AutoField, type ConfigFieldSchema } from "@/components/config/auto-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { usePageHeader } from "@/contexts/page-header";
import { cn } from "@/lib/utils";

export interface ConfigSection {
  key: string;
  label: string;
  description?: string;
  fields: ConfigFieldDef[];
}

export interface ConfigFieldDef {
  key: string;
  label: string;
  description?: string;
  type: "string" | "number" | "boolean" | "select" | "object";
  options?: string[];
  placeholder?: string;
}

/** Expand an `object` field into its leaf children, recursively. */
function expandField(field: ConfigFieldDef): ConfigFieldSchema[] {
  if (field.type !== "object") {
    const { type, ...rest } = field;
    return [{ ...rest, type: type as ConfigFieldSchema["type"] }];
  }
  return [];
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const next = (cur[key] as Record<string, unknown> | undefined) ?? {};
    cur[key] = next;
    cur = next;
  }
  cur[path[path.length - 1]] = value;
}

function getPath(target: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = target;
  for (const key of path) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function ConfigEditor({
  sections,
  initial,
}: {
  sections: ConfigSection[];
  initial: Record<string, unknown>;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(() => structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeSection, setActiveSection] = useState(sections[0]?.key ?? "");
  const { setEnd } = usePageHeader();

  const section = sections.find((s) => s.key === activeSection) ?? sections[0];

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setSaved(false);
    } finally {
      setSaving(false);
    }
  }, [config]);

  useEffect(() => {
    setEnd(
      <Button
        type="button"
        size="sm"
        disabled={saving}
        onClick={() => void save()}
        className="shrink-0"
      >
        {saving ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
      </Button>,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, saved, save, setEnd]);

  const updateField = (path: string[], value: unknown) => {
    setConfig((prev) => {
      const next = structuredClone(prev);
      setPath(next, path, value);
      return next;
    });
    setSaved(false);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <nav className="flex flex-wrap gap-1 lg:flex-col">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveSection(s.key)}
            className={cn(
              "rounded-md px-3 py-2 text-left text-sm transition-colors",
              activeSection === s.key
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {section && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{section.label}</CardTitle>
            {section.description && <CardDescription>{section.description}</CardDescription>}
          </CardHeader>
          <CardContent className="grid gap-5">
            {section.fields.flatMap((field) => {
              if (field.type === "object") {
                // Render the object's own sub-keys (e.g. runtime.sandbox).
                const path = [section.key, field.key];
                const value = getPath(config, path);
                if (value && typeof value === "object" && !Array.isArray(value)) {
                  return Object.entries(value as Record<string, unknown>).map(
                    ([subKey, subValue]) => {
                      const subPath = [...path, subKey];
                      const schema: ConfigFieldSchema = {
                        key: subKey,
                        label: subKey,
                        type:
                          typeof subValue === "number"
                            ? "number"
                            : typeof subValue === "boolean"
                              ? "boolean"
                              : subKey === "provider"
                                ? "select"
                                : "string",
                        options: subKey === "provider" ? ["daytona"] : undefined,
                      };
                      return (
                        <AutoField
                          key={subPath.join(".")}
                          schema={schema}
                          value={subValue}
                          onChange={(next) => updateField(subPath, next)}
                        />
                      );
                    },
                  );
                }
                return [];
              }
              const schema = expandField(field)[0];
              if (!schema) return [];
              const path = [section.key, field.key];
              const value = getPath(config, path);
              return [
                <AutoField
                  key={path.join(".")}
                  schema={schema}
                  value={value}
                  onChange={(next) => updateField(path, next)}
                />,
              ];
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
