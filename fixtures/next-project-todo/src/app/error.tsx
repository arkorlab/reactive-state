'use client';

import { operationOutcome } from '@arkorlab/reactive-state/react';
import type { ReactNode } from 'react';

/** What the page says of each failure, telling them apart as the fixture's error policy does. */
const SAID = {
  failed: '操作を完了できませんでした。',
  refused: '操作は受け付けられませんでした。入力や権限を確かめてください。',
  unknown: '操作が保存されたか確かめられませんでした。もう一度表示して確かめてください。',
} as const;

/**
 * What a page shows when something under it threw. A server operation the authority refused — an
 * input it rejected, an access it no longer has — is told apart from one whose outcome is unknown,
 * by what its error's digest says (`operationOutcome`), which production keeps while it hides the
 * message; anything else — a Server Function whose answer never came among it — is a failure the
 * page cannot say more of.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly retry: () => void;
}): ReactNode {
  const outcome = operationOutcome(error) ?? 'failed';
  return (
    <main>
      <p role="alert" data-outcome={outcome} data-testid="error">
        {SAID[outcome]}
      </p>
      <button
        type="button"
        onClick={() => {
          retry();
        }}
      >
        もう一度表示する
      </button>
    </main>
  );
}
