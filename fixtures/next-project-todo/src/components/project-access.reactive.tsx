import type { ReactNode } from 'react';
import { requireUser } from '@/auth';
import { requireProjectAccess } from '@/permissions';

export default async function ProjectAccess({ projectId, children }: {
  projectId: string;
  children: ReactNode;
}) {
  const user = await requireUser();
  await requireProjectAccess(user, projectId);

  return <>{children}</>;
}
