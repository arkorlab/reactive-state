import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { db } from '@/db';
import { assertCanReadTodo } from '@/permissions';

export default async function TodoReadOnly({ projectId, id }: {
  projectId: string; id: string;
}) {
  const user = await requireUser();
  await assertCanReadTodo(user, projectId, id);

  const ref = db.todos.ref(id);
  const [title] = useReactiveState(ref.title);
  const [completed] = useReactiveState(ref.completed);
  const [estimate] = useReactiveState(ref.estimate);

  return (
    <section>
      <h3>{title || '無題'}</h3>
      <p>{completed ? '完了' : '未完了'} / 見積もり {estimate}</p>
      <p>閲覧のみ</p>
    </section>
  );
}
