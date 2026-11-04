import type { ReactNode } from 'react';

export default function ProjectLayout({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main data-testid="project-layout">
      <h2>{title}</h2>
      <div className="project-layout">{children}</div>
    </main>
  );
}
