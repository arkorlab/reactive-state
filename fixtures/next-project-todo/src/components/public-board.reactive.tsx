import { requirePublishedProject } from '@/publication';
import PublicBoardLayout from '@/components/public-board-layout.reactive';
import PublicBoardStats from '@/components/public-board-stats.reactive';
import PublicBoardTodos from '@/components/public-board-todos.reactive';

export default async function PublicBoard({ projectId }: {
  projectId: string;
}) {
  const project = await requirePublishedProject(projectId);

  return (
    <PublicBoardLayout title={project.title}>
      <PublicBoardStats projectId={projectId} />
      <PublicBoardTodos projectId={projectId} />
    </PublicBoardLayout>
  );
}
