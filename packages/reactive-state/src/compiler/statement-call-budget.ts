import { type CallExpression, isCallExpression, type Node } from 'typescript/ast';

import { isErasedOrAmbient } from './statement-call-scopes.ts';

/** What one walk may spend resolving values before the rest of the statement is read coarsely. */
const WALK_BUDGET = { steps: 100_000 } as const;

/** Thrown when one walk has used up the steps it may spend resolving values. */
export class WalkBudgetError extends Error {
  public constructor() {
    super('The walk spent its budget.');
    this.name = 'WalkBudgetError';
  }
}

/** A counter for one walk: each call is one step of resolving a value, and the last allowed throws. */
export function createStepCounter(): () => void {
  let spent = 0;
  return () => {
    spent += 1;
    if (spent > WALK_BUDGET.steps) {
      throw new WalkBudgetError();
    }
  };
}

/**
 * Where the walk spent its budget, a form it cannot follow cheaply: every call written anywhere
 * within `root` counts as one that may run, so a state or hook call in it is refused.
 */
export function forEachCallWithin(root: Node, onCall: (call: CallExpression) => boolean): void {
  let stopped = false;
  const visit = (node: Node): void => {
    if (stopped || isErasedOrAmbient(node)) {
      return;
    }
    if (isCallExpression(node) && onCall(node)) {
      stopped = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(root);
}
