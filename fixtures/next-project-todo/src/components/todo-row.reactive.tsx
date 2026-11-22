import Link from 'next/link';
import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { db } from '@/db';
import { assertCanReadTodo } from '@/permissions';
import { projectHref, type TodoFilter } from '@/navigation';

export default async function TodoRow({ projectId, id, filter }: {
  projectId: string; id: string; filter: TodoFilter;
}) {
  const user = await requireUser();
  await assertCanReadTodo(user, projectId, id);

  const ref = db.todos.ref(id);
  const [title] = useReactiveState(ref.title);
  const [completed] = useReactiveState(ref.completed);
  const [estimate] = useReactiveState(ref.estimate);

  return (
    <li data-todo-id={id}>
      <Link href={projectHref(projectId, filter, id)}>{title || '無題'}</Link>
      {' — '}{completed ? '完了' : '未完了'} / 見積もり {estimate}
    </li>
  );
}
