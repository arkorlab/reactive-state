'use client';

import type { TodoFilter } from '@/navigation';
import { MAX_PANELS, type TodoChoice } from '@/domain/todo-panels';

// Ordinary controlled UI. No DB, Authority, frame, subscription or Reactive runtime API.
export default function WorkspaceControls({
  choices, filter, panelCount, onFilterChange, onOpenTodo, onOpenMany,
}: {
  choices: readonly TodoChoice[];
  filter: TodoFilter;
  panelCount: number;
  onFilterChange: (filter: TodoFilter) => void;
  onOpenTodo: (todoId: string) => void;
  onOpenMany: (todoIds: readonly string[]) => void;
}) {
  const full = panelCount >= MAX_PANELS;

  return (
    <section data-testid="workspace-controls">
      <fieldset aria-label="一覧の絞り込み">
        <legend>一覧の絞り込み</legend>
        <button type="button" aria-pressed={filter === 'all'}
          onClick={() => onFilterChange('all')}>すべて</button>
        <button type="button" aria-pressed={filter === 'active'}
          onClick={() => onFilterChange('active')}>未完了</button>
        <button type="button" aria-pressed={filter === 'done'}
          onClick={() => onFilterChange('done')}>完了</button>
      </fieldset>

      <p data-testid="panel-count">開いている詳細: {panelCount} / {MAX_PANELS}</p>
      <button type="button" data-testid="open-two"
        disabled={full || choices.length === 0}
        onClick={() => onOpenMany(choices.slice(0, 2).map(todo => todo.id))}>
        先頭の2件をまとめて開く
      </button>
      <ul aria-label="追加できる Todo">
        {choices.map(todo => (
          <li key={todo.id}>
            <button type="button" disabled={full} data-open-todo={todo.id}
              onClick={() => onOpenTodo(todo.id)}>
              {todo.title || '無題'} の詳細を追加
            </button>
          </li>
        ))}
      </ul>
      {choices.length === 0 && <p>追加できる Todo はありません。</p>}
    </section>
  );
}
