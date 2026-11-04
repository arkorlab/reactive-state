import { requireUser } from '@/auth';
import { db } from '@/db';
import { requireProjectAccess } from '@/permissions';
import TodoEditor from '@/components/todo-editor.reactive';
import TodoReadOnly from '@/components/todo-readonly.reactive';

export default async function TodoDetails({ projectId, id }: {
  projectId: string; id: string;
}) {
  const user = await requireUser();
  const access = await requireProjectAccess(user, projectId);
  const todo = await db.todos.get(id);

  // No hooks precede/follow this conditional in this component.
  if (todo === null || todo.projectId !== projectId) {
    return <p role="status">選択した Todo は削除または移動されました。</p>;
  }

  return access.canEdit
    ? <TodoEditor key={id} projectId={projectId} id={id} />
    : <TodoReadOnly key={id} projectId={projectId} id={id} />;
}
