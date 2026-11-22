import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { db } from '@/db';
import { assertCanManageMembership } from '@/permissions';
import { Checkbox } from '@/ui';

export default async function MemberEditor({ projectId, id }: {
  projectId: string; id: string;
}) {
  const user = await requireUser();
  await assertCanManageMembership(user, projectId, id);

  const [canEdit, setCanEdit] = useReactiveState(db.memberships.ref(id).canEdit);
  return (
    <label>
      {id} の編集権限
      <Checkbox checked={canEdit} onCheckedChange={setCanEdit} />
    </label>
  );
}
