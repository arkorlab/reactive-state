import { forbidden } from '@arkorlab/reactive-state/server';
import { db } from '@/db';
import PublicBoardLayout from '@/components/public-board-layout.reactive';
import PublicBoardStats from '@/components/public-board-stats.reactive';
import PublicBoardTodos from '@/components/public-board-todos.reactive';

export default async function PublicBoard({ projectId }: {
  projectId: string;
}) {
  // In this variant, the matched route's middleware checks publication first.
  // This component is reached under that route scope; it is not a new anonymous endpoint.
  const project = await db.projects.get(projectId);
  if (project === null) {
    forbidden();
  }

  return (
    <PublicBoardLayout title={project.title}>
      <PublicBoardStats projectId={projectId} />
      <PublicBoardTodos projectId={projectId} />
    </PublicBoardLayout>
  );
}
