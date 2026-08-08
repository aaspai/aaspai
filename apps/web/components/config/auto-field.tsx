"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface ConfigFieldSchema {
  key: string;
  label: string;
  description?: string;
  type: "string" | "number" | "boolean" | "select";
  options?: string[];
  placeholder?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Render a single config field based on its schema type — the Hermes
 * `AutoField` pattern (boolean → Switch, select → dropdown, number →
 * numeric input, everything else → text; nested objects recurse).
 */
export function AutoField({
  schema,
  value,
  onChange,
}: {
  schema: ConfigFieldSchema;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  if (schema.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm">{schema.label}</Label>
          {schema.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{schema.description}</p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value === true}
          onClick={() => onChange(value !== true)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
            value === true ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform",
              value === true ? "translate-x-[1.125rem]" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    );
  }

  if (schema.type === "select") {
    const options = schema.options ?? [];
    return (
      <div className="grid gap-1.5">
        <Label className="text-sm">{schema.label}</Label>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
        <Select
          value={value === undefined || value === null ? "" : String(value)}
          onValueChange={onChange}
        >
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (schema.type === "number") {
    return (
      <div className="grid gap-1.5">
        <Label className="text-sm">{schema.label}</Label>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
        <Input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const n = Number(raw);
            if (!Number.isNaN(n)) onChange(n);
          }}
          className="h-8 text-sm"
        />
      </div>
    );
  }

  // Nested object: render its sub-fields by reading the top-level config
  // section. `value` here is the full section object.
  if (isRecord(value)) {
    return (
      <div className="grid gap-3">
        <div>
          <Label className="text-sm">{schema.label}</Label>
          {schema.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{schema.description}</p>
          )}
        </div>
        <div className="grid gap-3 border-l-2 border-muted pl-4">
          {Object.entries(value).map(([subKey, subValue]) => (
            <div key={subKey}>
              <Label className="text-xs text-muted-foreground">{subKey}</Label>
              <Input
                value={typeof subValue === "string" ? subValue : JSON.stringify(subValue ?? "")}
                onChange={(e) => {
                  const next: Record<string, unknown> = { ...value };
                  next[subKey] = e.target.value;
                  onChange(next);
                }}
                className="mt-1 h-8 text-sm"
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label className="text-sm">{schema.label}</Label>
      {schema.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      <Input
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={schema.placeholder}
        className="h-8 text-sm"
      />
    </div>
  );
}
