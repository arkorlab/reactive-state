import { requireUser } from '@/auth';
import { assertCanEditProject } from '@/permissions';
import { createTodo, completeProject } from '@/actions/todos';

export default async function ProjectCommands({ projectId }: { projectId: string }) {
  const user = await requireUser();
  await assertCanEditProject(user, projectId);

  return (
    <section>
      <form action={createTodo.bind(null, projectId)}>
        <input name="title" aria-label="新しい Todo" required maxLength={200} />
        <button type="submit">追加</button>
      </form>
      <form action={completeProject.bind(null, projectId)}>
        <button type="submit">すべて完了にする</button>
      </form>
    </section>
  );
}
