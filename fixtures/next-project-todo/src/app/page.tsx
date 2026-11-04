import type { ReactNode } from 'react';

/** Where the specification's screen is: the first project, its first to-do selected. */
export default function Home(): ReactNode {
  return (
    <main>
      <h1>Project Todo</h1>
      <p>
        <a href="/projects/p1?filter=all&todo=t1">プロジェクト p1 を開く</a>
      </p>
    </main>
  );
}
