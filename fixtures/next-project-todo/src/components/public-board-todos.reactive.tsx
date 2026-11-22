import { db } from '@/db';

export default async function PublicBoardTodos({ projectId }: {
  projectId: string;
}) {
  const todos = await db.todos.findMany({
    where: { projectId },
    select: { id: true, title: true, completed: true },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });

  if (todos.length === 0) {
    return <p data-testid="public-empty">公開する Todo はまだありません。</p>;
  }

  return (
    <ul data-testid="public-todos">
      {todos.map(todo => (
        <li key={todo.id} data-todo-id={todo.id} data-completed={String(todo.completed)}>
          <span>{todo.title || '無題'}</span>
          {' — '}
          <span>{todo.completed ? '完了' : '未完了'}</span>
        </li>
      ))}
    </ul>
  );
}
