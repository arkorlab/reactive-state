import './globals.css';
import type { ReactNode } from 'react';

import { SessionButtons } from '@/fixture/session-buttons';

export const metadata = {
  title: 'Project Todo',
  description: 'Reactive components whose state an authority owns: lists, counts and editors.',
};

/**
 * The fixture's frame around its pages: a way to its two projects, and the demo's sign-in as
 * Alice or Bob, which the pages take as given.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <html lang="ja">
      <body>
        <nav aria-label="デモ" className="demo">
          <a href="/projects/p1?filter=all&todo=t1">開発 (p1)</a>
          <a href="/projects/p2?filter=all">運用 (p2)</a>
          <SessionButtons />
        </nav>
        {children}
      </body>
    </html>
  );
}
