import PublicBoard from '@/components/public-board.reactive';

// A normal page. No cookies, session, cacheTag, refresh, or manual live Provider.
// The registered public route is generated as one shared document/RSC view.
export default async function Page({ params }: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <PublicBoard projectId={projectId} />;
}
