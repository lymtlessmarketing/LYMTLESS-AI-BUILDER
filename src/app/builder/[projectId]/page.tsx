import { BuilderWorkspace } from "@/components/builder-workspace";

export default async function BuilderPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <BuilderWorkspace projectId={projectId} />;
}
