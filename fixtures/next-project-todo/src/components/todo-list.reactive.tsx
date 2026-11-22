import type { TodoFilter } from '@/navigation';
import TodoRow from '@/components/todo-row.reactive';

export default function TodoList({ projectId, ids, filter }: {
  projectId: string;
  ids: readonly string[];
  filter: TodoFilter;
}) {
  return ids.length === 0
    ? <p data-testid="empty-list">該当する Todo はありません。</p>
    : <ul>{ids.map(id => <TodoRow key={id} projectId={projectId} id={id} filter={filter} />)}</ul>;
}
