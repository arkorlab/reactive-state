import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { assertOwnsProject } from '@/permissions';
import { db } from '@/db';
import { TextInput } from '@/ui';
import { publishBoard, withdrawBoard } from '@/actions/publication';

export default async function PublicationSettings({ projectId }: {
  projectId: string;
}) {
  const user = await requireUser();
  await assertOwnsProject(user, projectId);

  const ref = db.projects.ref(projectId);
  const [title, setTitle] = useReactiveState(ref.title);
  const [published] = useReactiveState(ref.published);
  const [internalNote, setInternalNote] = useReactiveState(ref.internalNote);

  return (
    <section data-testid="publication-settings">
      <h2>公開設定</h2>
      <label>
        プロジェクト名
        <TextInput aria-label="プロジェクト名" value={title} onChange={setTitle} />
      </label>
      <label>
        非公開の内部メモ
        <TextInput aria-label="非公開の内部メモ" value={internalNote} onChange={setInternalNote} />
      </label>

      <p data-testid="publication-state" data-published={String(published)}>
        DB の公開設定: {published ? '公開' : '非公開'}
      </p>
      <p>公開表示の準備は、保存の後にフレームワークが行います。</p>

      <form action={publishBoard.bind(null, projectId)}>
        <button type="submit">公開する</button>
      </form>
      <form action={withdrawBoard.bind(null, projectId)}>
        <button type="submit">公開を取り消す</button>
      </form>

      <p><a href={`/boards/${encodeURIComponent(projectId)}`}>公開ボードを開く</a></p>
      <p><a href={`/projects/${encodeURIComponent(projectId)}`}>編集画面へ戻る</a></p>
    </section>
  );
}
