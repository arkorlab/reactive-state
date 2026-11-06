/**
 * `framework/react` as a `.reactive.tsx` component, and a custom hook it calls, see it. Given a field
 * reference — `db.todos.ref(id).title`, from the application's own `@/db` — `useReactiveState`
 * binds the component to the authority's value of that field: the setter writes a value, or an
 * update of the current one the authority runs (`current => addEstimate(current, step)`). Given
 * anything else, it is React's own `useState`. The compiler replaces the import in what it writes,
 * and each update it can see with the one it registered; nothing of this module runs.
 */

import type { FieldRef, Value } from '../program.ts';

/** A setter: a next value, or a function of the current one. */
export type StateSetter<T> = (next: T | ((value: T) => T)) => void;

export declare function useReactiveState<T extends Value>(field: FieldRef<T>): [T, StateSetter<T>];
export declare function useReactiveState<T>(initial: T | (() => T)): [T, StateSetter<T>];
