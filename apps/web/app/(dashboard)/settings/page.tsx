import { CompanyBackup } from "@/components/company-backup";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Company backup and recovery</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Portable company export</CardTitle>
          <CardDescription>
            Version 2 includes strategy, execution definitions and work, knowledge, evidence, and
            governance records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompanyBackup />
        </CardContent>
      </Card>
    </div>
  );
}
