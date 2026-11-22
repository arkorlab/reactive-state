import type { TodoFilter } from '@/navigation';

// Pure application code, deliberately factored out of the component and custom hook.
export function normalizeFilter(value: string): TodoFilter {
  return value === 'active' || value === 'done' ? value : 'all';
}
