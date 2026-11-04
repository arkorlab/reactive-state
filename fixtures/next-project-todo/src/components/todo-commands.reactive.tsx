import { requireUser } from '@/auth';
import { assertCanEditTodo } from '@/permissions';
import { deleteTodo, moveTodo } from '@/actions/todos';

export default async function TodoCommands({ projectId, id }: {
  projectId: string; id: string;
}) {
  const user = await requireUser();
  await assertCanEditTodo(user, projectId, id);

  return (
    <div>
      <form action={deleteTodo.bind(null, projectId, id)}>
        <button type="submit">削除</button>
      </form>
      <form action={moveTodo.bind(null, projectId, id)}>
        <input name="targetProjectId" aria-label="移動先プロジェクト ID" required maxLength={64} />
        <button type="submit">移動</button>
      </form>
    </div>
  );
}
