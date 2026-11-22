import ProjectAccess from '@/components/project-access.reactive';
import ProjectContent from '@/components/project-content.reactive';
import type { TodoFilter } from '@/navigation';

export default function Project({ projectId, filter, selectedId }: {
  projectId: string;
  filter: TodoFilter;
  selectedId?: string;
}) {
  return (
    <ProjectAccess projectId={projectId}>
      <ProjectContent
        projectId={projectId}
        initialFilter={filter}
        initialSelectedId={selectedId ?? ''}
      />
    </ProjectAccess>
  );
}
