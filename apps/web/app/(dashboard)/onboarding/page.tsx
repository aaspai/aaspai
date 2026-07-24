import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { currentUser } from "@/lib/local-auth";
import { listFrontendProviders } from "@/lib/provider-status";
import { readFrontendOnboarding } from "@/lib/workspace-bootstrap";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await currentUser();
  const existingOnboarding = await readFrontendOnboarding();
  if (existingOnboarding?.completedAt) redirect("/company");
  const providers = await listFrontendProviders();
  return (
    <OnboardingWizard companyName={user?.companyName ?? "your company"} providers={providers} />
  );
}
