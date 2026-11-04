import type { ReactNode } from 'react';

export default function PublicBoardLayout({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main data-testid="public-board">
      <h1 data-testid="public-title">{title}</h1>
      <p>公開された Todo と件数は、変更が確定すると自動的に更新されます。</p>
      {children}
    </main>
  );
}
