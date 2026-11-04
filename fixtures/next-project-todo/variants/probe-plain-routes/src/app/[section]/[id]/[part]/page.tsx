import type { ReactNode } from 'react';

/**
 * A probe of this repository's, not part of the specification: a page of no reactive root whose
 * route opens with a dynamic segment, of as many segments as the compile's own route's paths
 * (`/api/reactive-state/session`), under the app's middleware. Its rewrite runs before Next.js's
 * dynamic routes, the compile's own among them, and takes none of that route's requests.
 */
export default function Part(): ReactNode {
  return (
    <main>
      <p data-testid="part">part</p>
    </main>
  );
}
