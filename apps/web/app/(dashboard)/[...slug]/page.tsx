import { FeaturePage } from "@/components/feature-page";

export default async function CatchAllPage({ params }: { params: Promise<{ slug: string[] }> }) {
  return <FeaturePage slug={(await params).slug} />;
}
