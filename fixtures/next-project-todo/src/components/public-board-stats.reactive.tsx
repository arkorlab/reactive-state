import { db } from '@/db';

export default async function PublicBoardStats({ projectId }: {
  projectId: string;
}) {
  const total = await db.todos.count({ where: { projectId } });
  const remaining = await db.todos.count({ where: { projectId, completed: false } });

  return (
    <section aria-label="公開された集計">
      <p data-testid="public-stats" data-total={total} data-remaining={remaining}>
        全 {total} 件 / 未完了 {remaining} 件 / 完了 {total - remaining} 件
      </p>
    </section>
  );
}
