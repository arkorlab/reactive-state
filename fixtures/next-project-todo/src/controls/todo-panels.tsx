'use client';

import { type ReactNode, useState } from 'react';
import type { TodoChoice, TodoPanel } from '@/domain/todo-panels';

// Outside the content's Suspense boundary: selection/reorder/close remain operable
// while an earlier read is pending. This UI has no server or Reactive dependencies.
export function PanelControls({
  panels, choices, onClose, onCloseAll, onMove, onReplaceTodo,
}: {
  panels: readonly TodoPanel[];
  choices: readonly TodoChoice[];
  onClose: (panelId: string) => void;
  onCloseAll: () => void;
  onMove: (panelId: string, direction: -1 | 1) => void;
  onReplaceTodo: (panelId: string, todoId: string) => void;
}) {
  return (
    <section aria-label="開いているパネルの操作" data-testid="panel-controls">
      <button type="button" disabled={panels.length === 0}
        data-testid="close-all" onClick={onCloseAll}>すべて閉じる</button>
      <ol>
        {panels.map((panel, index) => (
          <li key={panel.panelId} data-control-panel={panel.panelId}>
            <label>
              パネル {index + 1} の Todo
              <select value={panel.todoId} data-testid="panel-target"
                onChange={event => onReplaceTodo(panel.panelId, event.currentTarget.value)}>
                {!choices.some(todo => todo.id === panel.todoId) && (
                  <option value={panel.todoId}>削除・移動済み: {panel.todoId}</option>
                )}
                {choices.map(todo => (
                  <option key={todo.id} value={todo.id}>{todo.title || '無題'}</option>
                ))}
              </select>
            </label>
            <button type="button" disabled={index === 0} data-testid="move-left"
              onClick={() => onMove(panel.panelId, -1)}>左へ</button>
            <button type="button" disabled={index === panels.length - 1} data-testid="move-right"
              onClick={() => onMove(panel.panelId, 1)}>右へ</button>
            <button type="button" data-testid="close-panel"
              onClick={() => onClose(panel.panelId)}>閉じる</button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// This state belongs to the panel, not the Todo and not the server component below.
export function PanelCard({ panelId, todoId, children }: {
  panelId: string;
  todoId: string;
  children: ReactNode;
}) {
  const [memo, setMemo] = useState('');

  return (
    <article data-testid="panel" data-panel-id={panelId} data-todo-id={todoId}>
      <h3>Todo {todoId}</h3>
      <label>
        このパネルだけのメモ
        <textarea data-testid="panel-memo" value={memo}
          onChange={event => setMemo(event.currentTarget.value)} />
      </label>
      {children}
    </article>
  );
}
