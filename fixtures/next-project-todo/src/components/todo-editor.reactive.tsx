import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { db } from '@/db';
import { assertCanEditTodo } from '@/permissions';
import { TextInput, Checkbox } from '@/ui';
import { useEstimate } from '@/hooks/use-estimate';
import TodoCommands from '@/components/todo-commands.reactive';

export default async function TodoEditor({ projectId, id }: {
  projectId: string; id: string;
}) {
  const user = await requireUser();
  await assertCanEditTodo(user, projectId, id);

  const ref = db.todos.ref(id);
  const [title, setTitle] = useReactiveState(ref.title);
  const [completed, setCompleted] = useReactiveState(ref.completed);
  const [step, setStep] = useReactiveState(1);
  const [expanded, setExpanded] = useReactiveState(false);
  const [draft, setDraft] = useReactiveState('');
  const [estimate, increase] = useEstimate(ref.estimate, step);

  const status = completed ? '完了' : '未完了';

  return (
    <section data-testid="editor">
      <TextInput aria-label="タイトル" value={title} onChange={setTitle} />
      <Checkbox aria-label="完了" checked={completed} onCheckedChange={setCompleted} />
      <p>{status}</p>

      <label>
        加算する見積もり
        <select value={step} onChange={event => setStep(Number(event.currentTarget.value))}>
          <option value={1}>1</option>
          <option value={5}>5</option>
        </select>
      </label>
      <button type="button" onClick={increase}>見積もり {estimate} に {step} 加算</button>

      <button type="button" onClick={() => setExpanded(open => !open)}>詳細</button>
      {expanded && (
        <label>
          自分だけのメモ
          <textarea value={draft} onChange={event => setDraft(event.currentTarget.value)} />
        </label>
      )}

      <TodoCommands projectId={projectId} id={id} />
    </section>
  );
}
