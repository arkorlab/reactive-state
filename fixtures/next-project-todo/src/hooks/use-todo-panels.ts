import { useReactiveState } from 'framework/react';
import {
  appendPanels,
  movePanelBy,
  removePanel,
  replacePanelTodo,
  type TodoPanel,
} from '@/domain/todo-panels';

export function useTodoPanels(initialPanels: readonly TodoPanel[]) {
  const [panels, setPanels] = useReactiveState<readonly TodoPanel[]>(initialPanels);

  const openPanel = (todoId: string): void => {
    if (todoId === '') return;
    // This function is called from an event, never during rendering.
    // Allocate once BEFORE the updater, which React may evaluate more than once.
    const candidate: TodoPanel = { panelId: crypto.randomUUID(), todoId };
    setPanels(current => appendPanels(current, [candidate]));
  };

  const openMany = (todoIds: readonly string[]): void => {
    // One user event constructs the whole set, then queues one local state update.
    const candidates: readonly TodoPanel[] = todoIds
      .filter(todoId => todoId !== '')
      .map(todoId => ({ panelId: crypto.randomUUID(), todoId }));
    setPanels(current => appendPanels(current, candidates));
  };

  const closePanel = (panelId: string): void => {
    setPanels(current => removePanel(current, panelId));
  };

  const closeAll = (): void => {
    setPanels([]);
  };

  const movePanel = (panelId: string, direction: -1 | 1): void => {
    setPanels(current => movePanelBy(current, panelId, direction));
  };

  const replaceTodo = (panelId: string, todoId: string): void => {
    setPanels(current => replacePanelTodo(current, panelId, todoId));
  };

  return { panels, openPanel, openMany, closePanel, closeAll, movePanel, replaceTodo };
}
