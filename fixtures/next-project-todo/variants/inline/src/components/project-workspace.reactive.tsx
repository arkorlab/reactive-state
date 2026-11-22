import { Suspense, type ReactNode } from 'react';
import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { requireProjectAccess } from '@/permissions';
import type { TodoFilter } from '@/navigation';
import Disclosure from '@/controls/disclosure';
import WorkspaceControls from '@/controls/workspace-controls';
import { PanelCard, PanelControls } from '@/controls/todo-panels';
import TodoResults from '@/components/todo-results.reactive';
import TodoDetails from '@/components/todo-details.reactive';
import { initialPanelsFor, appendPanels, removePanel, movePanelBy, replacePanelTodo, type TodoPanel } from '@/domain/todo-panels';
import { normalizeFilter } from '@/domain/todo-filter';

export default async function ProjectWorkspace({
  projectId, initialFilter, initialSelectedId, choices, children,
}: {
  projectId: string;
  initialFilter: TodoFilter;
  initialSelectedId: string;
  choices: readonly { readonly id: string; readonly title: string }[];
  children: ReactNode;
}) {
  const user = await requireUser();
  await requireProjectAccess(user, projectId);
  const initialPanels = initialPanelsFor(initialSelectedId);

  const [workspaceMemo, setWorkspaceMemo] = useReactiveState('');
  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);
  const [panels, setPanels] = useReactiveState<readonly TodoPanel[]>(initialPanels);

  const renderedFilter = normalizeFilter(filter);

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

  return (
    <section data-testid="workspace">
      <Disclosure title="プロジェクト全体の確定集計">
        {children}
      </Disclosure>

      <WorkspaceControls
        choices={choices}
        filter={filter}
        panelCount={panels.length}
        onFilterChange={setFilter}
        onOpenTodo={openPanel}
        onOpenMany={openMany}
      />

      <label>
        この画面だけのメモ
        <textarea data-testid="workspace-memo" value={workspaceMemo}
          onChange={event => setWorkspaceMemo(event.currentTarget.value)} />
      </label>

      <PanelControls
        panels={panels}
        choices={choices}
        onClose={closePanel}
        onCloseAll={closeAll}
        onMove={movePanel}
        onReplaceTodo={replaceTodo}
      />

      <Suspense fallback={<p role="status" data-testid="workspace-pending">一覧と詳細を読み込み中...</p>}>
        <TodoResults projectId={projectId} filter={renderedFilter} />

        <div data-testid="panels">
          {panels.map(panel => (
            <PanelCard key={panel.panelId} panelId={panel.panelId} todoId={panel.todoId}>
              <TodoDetails
                key={`${projectId}:${panel.todoId}`}
                projectId={projectId}
                id={panel.todoId}
              />
            </PanelCard>
          ))}
          {panels.length === 0 && <p data-testid="no-panels">詳細は表示していません。</p>}
        </div>
      </Suspense>
    </section>
  );
}
