import { requireUser } from '@/auth';
import { db } from '@/db';
import { requireProjectAccess } from '@/permissions';
import type { TodoFilter } from '@/navigation';
import TodoList from '@/components/todo-list.reactive';

export default async function TodoResults({ projectId, filter }: {
  projectId: string;
  filter: TodoFilter;
}) {
  const user = await requireUser();
  await requireProjectAccess(user, projectId);

  const where = filter === 'all'
    ? { projectId }
    : { projectId, completed: filter === 'done' };
  const todos = await db.todos.findMany({
    where,
    select: { id: true },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });
  const label = filter === 'all' ? 'すべて' : filter === 'active' ? '未完了' : '完了';

  return (
    <section data-testid="results" data-filter={filter}>
      <h3>表示中の一覧: {label} / {todos.length} 件</h3>
      <TodoList projectId={projectId} ids={todos.map(todo => todo.id)} filter={filter} />
    </section>
  );
}
