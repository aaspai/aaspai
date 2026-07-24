"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AuthForm() {
  const router = useRouter();
  const [signupMode, setSignupMode] = useState(true);
  const [values, setValues] = useState({ name: "", email: "", password: "", companyName: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: signupMode ? "signup" : "login", ...values }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Authentication failed");
      router.push(signupMode ? "/onboarding" : "/company");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      {signupMode && (
        <Field
          label="Your name"
          value={values.name}
          onChange={(name) => setValues({ ...values, name })}
        />
      )}
      <Field
        label="Email"
        type="email"
        value={values.email}
        onChange={(email) => setValues({ ...values, email })}
      />
      <Field
        label="Password"
        type="password"
        value={values.password}
        onChange={(password) => setValues({ ...values, password })}
      />
      {signupMode && (
        <Field
          label="Company name"
          value={values.companyName}
          onChange={(companyName) => setValues({ ...values, companyName })}
        />
      )}
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button className="w-full" disabled={busy}>
        {busy ? "Working…" : signupMode ? "Create company" : "Sign in"}
      </Button>
      <button
        type="button"
        className="w-full text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setSignupMode(!signupMode)}
      >
        {signupMode ? "Already have an account? Sign in" : "New here? Create a company"}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  const id = label.toLowerCase().replaceAll(" ", "-");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </div>
  );
}
