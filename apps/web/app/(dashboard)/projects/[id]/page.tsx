import { notFound } from "next/navigation";
import { ProjectWorkspace } from "@/components/project-workspace";
import { getCompanyOverview, getStrategicSummary, isAaspaiWorkspace } from "@/lib/aaspai";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isAaspaiWorkspace()) notFound();
  const { id } = await params;
  const overview = await getCompanyOverview();
  const strategic = await getStrategicSummary();
  const project = overview.projects.find((item) => item.id === decodeURIComponent(id));
  if (!project) notFound();
  return (
    <ProjectWorkspace
      project={project}
      tasks={overview.workItems.filter((item) => item.projectId === project.id)}
      milestones={
        strategic?.projects
          .find((item) => item.id === project.id)
          ?.milestones.map(({ id: milestoneId, title, status }) => ({
            id: milestoneId,
            title,
            status,
          })) ?? []
      }
    />
  );
}
