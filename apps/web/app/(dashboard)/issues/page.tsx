import { IssuesBoard } from "@/components/issues-board";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCompanyOverview, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function IssuesPage() {
  if (!isAaspaiWorkspace())
    return (
      <Card>
        <CardHeader>
          <CardTitle>Issues</CardTitle>
          <CardDescription>Initialize a workspace to manage issues.</CardDescription>
        </CardHeader>
      </Card>
    );
  const overview = await getCompanyOverview();
  return <IssuesBoard issues={overview.workItems} />;
}
