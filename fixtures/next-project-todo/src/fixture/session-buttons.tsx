'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState, useTransition } from 'react';

/** The demo's users, chosen without a password on a page served to this machine alone. */
const USERS = [
  { id: 'alice', label: 'Alice としてサインイン' },
  { id: 'bob', label: 'Bob としてサインイン' },
  { id: 'carol', label: 'Carol としてサインイン' },
] as const;

/** The route the compile writes for the application (`api/reactive-state/[...path]`). */
const SESSION_ROUTE = '/api/reactive-state/session';

async function messageOf(response: Response): Promise<string> {
  try {
    const { error } = (await response.json()) as { readonly error?: unknown };
    return typeof error === 'string' ? error : `HTTP ${String(response.status)}`;
  } catch {
    return `HTTP ${String(response.status)}`;
  }
}

/** Signs in as one of the demo's users; a sign-in renders the page again for the new session. */
export function SessionButtons(): ReactNode {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();
  const signIn = (user: string): void => {
    startTransition(async () => {
      try {
        const response = await fetch(SESSION_ROUTE, {
          body: JSON.stringify({ user }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        });
        setError(response.ok ? '' : await messageOf(response));
        if (response.ok) {
          router.refresh();
        }
      } catch (error_) {
        setError(error_ instanceof Error ? error_.message : String(error_));
      }
    });
  };
  return (
    <span className="session" aria-busy={pending}>
      {USERS.map(({ id, label }) => {
        return (
          <button
            data-testid={`sign-in-${id}`}
            key={id}
            type="button"
            onClick={() => {
              signIn(id);
            }}
          >
            {label}
          </button>
        );
      })}
      {error !== '' && (
        <span data-testid="session-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
