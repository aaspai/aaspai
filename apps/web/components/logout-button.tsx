"use client";

export function LogoutButton() {
  async function logout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    window.location.assign("/login");
  }
  return (
    <button
      type="button"
      onClick={logout}
      className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      Sign out
    </button>
  );
}
