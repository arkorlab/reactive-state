import { requireUser } from '@/auth';
import { db } from '@/db';
import { requireProjectAccess } from '@/permissions';
import type { TodoFilter } from '@/navigation';
import ProjectLayout from '@/components/project-layout.reactive';
import ProjectWorkspace from '@/components/project-workspace.reactive';
import ProjectSummary from '@/components/project-summary.reactive';
import ProjectCommands from '@/components/project-commands.reactive';
import MemberEditor from '@/components/member-editor.reactive';

export default async function ProjectContent({
  projectId, initialFilter, initialSelectedId,
}: {
  projectId: string;
  initialFilter: TodoFilter;
  initialSelectedId: string;
}) {
  const user = await requireUser();
  const access = await requireProjectAccess(user, projectId);

  // All this project's ids are choices, even when the list below is filtered.
  const choices = await db.todos.findMany({
    where: { projectId },
    select: { id: true, title: true },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });
  const memberships = access.canManageMembers
    ? await db.memberships.findMany({ where: { projectId }, orderBy: [{ id: 'asc' }] })
    : [];

  return (
    <ProjectLayout title={access.project.title}>
      <ProjectWorkspace
        key={JSON.stringify([projectId, initialFilter, initialSelectedId])}
        projectId={projectId}
        initialFilter={initialFilter}
        initialSelectedId={initialSelectedId}
        choices={choices}
      >
        <ProjectSummary projectId={projectId} />
      </ProjectWorkspace>

      {access.canEdit && <ProjectCommands projectId={projectId} />}

      {access.canManageMembers && (
        <aside>
          <h3>メンバーの編集権限</h3>
          {memberships.map(membership => (
            <MemberEditor
              key={membership.id}
              projectId={projectId}
              id={membership.id}
            />
          ))}
        </aside>
      )}
    </ProjectLayout>
  );
}
