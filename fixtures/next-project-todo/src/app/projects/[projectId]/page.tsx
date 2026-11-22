import { Suspense } from 'react';
import Project from '@/components/project.reactive';
import type { TodoFilter } from '@/navigation';

type Search = Record<string, string | string[] | undefined>;

// Thin Next.js route adapter only; no manually written reactive Provider/Action/registry.
export default function Page(props: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Search>;
}) {
  return (
    <>
      <header><h1>Project Todo</h1></header>
      <Suspense fallback={<p>プロジェクトを読み込み中...</p>}>
        <ProjectRoute {...props} />
      </Suspense>
    </>
  );
}

async function ProjectRoute({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Search>;
}) {
  const { projectId } = await params;
  const search = await searchParams;
  const filter: TodoFilter = search['filter'] === 'active' || search['filter'] === 'done'
    ? search['filter'] : 'all';
  const selectedId = search['todo'];
  return typeof selectedId === 'string'
    ? <Project projectId={projectId} filter={filter} selectedId={selectedId} />
    : <Project projectId={projectId} filter={filter} />;
}
