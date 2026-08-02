import { notFound } from "next/navigation";
import { TaskWorkspace } from "@/components/project-workspace";
import { getCompanyOverview, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isAaspaiWorkspace()) notFound();
  const { id } = await params;
  const overview = await getCompanyOverview();
  const task = overview.workItems.find((item) => item.id === decodeURIComponent(id));
  if (!task) notFound();
  const project = overview.projects.find((item) => item.id === task.projectId);
  const evidence = overview.evidence.filter((item) => item.workItemId === task.id).slice(0, 5);
  const comments = evidence.map((item) => ({
    id: item.id,
    author: "Execution system",
    body: item.body,
    timestamp: item.createdAt,
  }));
  return (
    <TaskWorkspace
      task={task}
      projectTitle={project?.title ?? task.projectId}
      comments={comments}
    />
  );
}
