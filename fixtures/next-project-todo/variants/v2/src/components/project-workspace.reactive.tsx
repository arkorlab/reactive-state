import { Suspense, type ReactNode } from 'react';
import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { requireProjectAccess } from '@/permissions';
import type { TodoFilter } from '@/navigation';
import Disclosure from '@/controls/disclosure';
import TodoResults from '@/components/todo-results.reactive';
import TodoDetails from '@/components/todo-details.reactive';

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

  const [filter, setFilter] = useReactiveState<TodoFilter>(initialFilter);
  const [selectedId, setSelectedId] = useReactiveState(initialSelectedId);
  const [showDetails, setShowDetails] = useReactiveState(true);
  const [memo, setMemo] = useReactiveState('');

  const selectionMissing = selectedId !== '' && !choices.some(todo => todo.id === selectedId);

  return (
    <section data-testid="workspace">
      <Disclosure title="プロジェクト全体の確定集計">
        {children}
      </Disclosure>

      <fieldset aria-label="一覧の絞り込み">
        <legend>一覧の絞り込み</legend>
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          すべて
        </button>
        <button type="button" aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>
          未完了
        </button>
        <button type="button" aria-pressed={filter === 'done'} onClick={() => setFilter('done')}>
          完了
        </button>
      </fieldset>

      <label>
        詳細で開く Todo
        <select
          data-testid="local-selection"
          value={selectedId}
          onChange={event => setSelectedId(event.currentTarget.value)}
        >
          <option value="">選択しない</option>
          {selectionMissing && <option value={selectedId}>削除・移動済み: {selectedId}</option>}
          {choices.map(todo => (
            <option key={todo.id} value={todo.id}>{todo.title || '無題'}</option>
          ))}
        </select>
      </label>

      <button
        type="button"
        aria-expanded={showDetails}
        onClick={() => setShowDetails(open => !open)}
      >
        {showDetails ? '詳細を閉じる' : '詳細を開く'}
      </button>

      <label>
        この画面だけのメモ
        <textarea
          data-testid="workspace-memo"
          value={memo}
          onChange={event => setMemo(event.currentTarget.value)}
        />
      </label>

      <Suspense fallback={<p role="status" data-testid="workspace-pending">一覧と詳細を読み込み中...</p>}>
        <TodoResults projectId={projectId} filter={filter} />
        <section aria-label="選択した Todo の詳細">
          {showDetails && selectedId !== '' ? (
            <TodoDetails
              key={`${projectId}:${selectedId}`}
              projectId={projectId}
              id={selectedId}
            />
          ) : (
            <p data-testid="detail-closed">詳細は表示していません。</p>
          )}
        </section>
      </Suspense>
    </section>
  );
}
