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
import { initialPanelsFor } from '@/domain/todo-panels';
import { useTodoFilter } from '@/hooks/use-todo-filter';
import { useTodoPanels } from '@/hooks/use-todo-panels';

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
  const { filter, setFilter, effectiveFilter } = useTodoFilter(initialFilter);
  const { panels, openPanel, openMany, closePanel, closeAll, movePanel, replaceTodo } =
    useTodoPanels(initialPanels);

  const filterAlias = effectiveFilter;
  const query = { filter: filterAlias };
  const sourcePanels = panels;
  const cards = sourcePanels.map(item => ({ panelId: item.panelId, todoId: item.todoId }));

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
        <TodoResults projectId={projectId} filter={query.filter} />

        <div data-testid="panels">
          {cards.map(panel => (
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
