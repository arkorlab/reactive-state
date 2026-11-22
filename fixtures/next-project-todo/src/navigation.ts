export type TodoFilter = 'all' | 'active' | 'done';

export function projectHref(
  projectId: string, filter: TodoFilter = 'all', selectedId?: string,
): string {
  const query = new URLSearchParams({ filter });
  if (selectedId !== undefined) query.set('todo', selectedId);
  return `/projects/${encodeURIComponent(projectId)}?${query.toString()}`;
}
