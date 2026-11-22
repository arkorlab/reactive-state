import { requireUser } from '@/auth';
import { db } from '@/db';
import { requireProjectAccess } from '@/permissions';

export default async function ProjectSummary({ projectId }: { projectId: string }) {
  const user = await requireUser();
  await requireProjectAccess(user, projectId);

  const remaining = await db.todos.count({ where: { projectId, completed: false } });
  const completed = await db.todos.count({ where: { projectId, completed: true } });

  return (
    <p data-testid="totals">
      確定した集計: 未完了 {remaining} 件 / 完了 {completed} 件
    </p>
  );
}
