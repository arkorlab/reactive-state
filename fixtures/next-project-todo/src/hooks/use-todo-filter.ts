import { useReactiveState } from 'framework/react';
import type { TodoFilter } from '@/navigation';
import { normalizeFilter } from '@/domain/todo-filter';

export function useTodoFilter(initialFilter: TodoFilter) {
  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);
  const effectiveFilter = normalizeFilter(filter);

  return { filter, setFilter, effectiveFilter };
}
