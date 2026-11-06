'use client';

/**
 * The React side of reactive-state: what the compiled Client Components and the roots `renderRoot`
 * renders run in the browser. `LiveRoot` shows a root the authority rendered with the frame it was
 * rendered at, and keeps it current; the compiled components read their states inside it through
 * `useReactiveState`, from what `stateOf` makes of their part, and render what the authority
 * rendered into them through `slotOf` — and, where it rendered it with values of their local
 * states, through `useSites`.
 */

export { type OperationOutcome, operationOutcome } from '../runtime/outcome.ts';
export type { StoreStatus } from '../runtime/store.ts';
export { LiveRoot, type LiveRootProps } from './live-root.tsx';
export { type Sites, useSites } from './sites.tsx';
export {
  type ClientPartProps,
  localOf,
  type LocalStateInput,
  type ReactiveSetter,
  slotOf,
  stateOf,
  type StateInput,
  useReactiveState,
  useReactiveStatus,
} from './state.ts';
