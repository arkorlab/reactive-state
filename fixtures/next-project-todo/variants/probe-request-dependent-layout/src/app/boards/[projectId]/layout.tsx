import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

export default async function BoardLayout({ children }: {
  children: ReactNode;
}) {
  // Synthetic presentation cookie, not authentication. Including absence matters too.
  const jar = await cookies();
  const viewer = jar.get('v4-test-viewer')?.value ?? 'anonymous';

  return (
    <section>
      <p data-testid="request-viewer">{viewer}</p>
      {children}
    </section>
  );
}
