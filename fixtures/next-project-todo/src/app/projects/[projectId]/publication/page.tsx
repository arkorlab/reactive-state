import { Suspense } from 'react';
import PublicationSettings from '@/components/publication-settings.reactive';

// Separate authenticated route: v3's workspace and its variants do not change.
export default function Page({ params }: {
  params: Promise<{ projectId: string }>;
}) {
  return (
    <Suspense fallback={<p role="status">公開設定を読み込み中...</p>}>
      <SettingsRoute params={params} />
    </Suspense>
  );
}

async function SettingsRoute({ params }: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <PublicationSettings projectId={projectId} />;
}
