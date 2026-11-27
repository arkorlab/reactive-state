import type { OperationArgument } from '../program.ts';

/**
 * The arguments a server operation is called with, from the form they cross to the authority in.
 * A leaf of no dependency but the protocol's types: the application's server (`operate`) reads them
 * as the authority's operation will, and loads nothing of the authority's to do it.
 */

/** The arguments an operation is called with: a form's entries as `FormData`, JSON as itself. */
export function argumentsOf(args: readonly OperationArgument[]): readonly unknown[] {
  return args.map((argument): unknown => {
    let value: unknown;
    if ('json' in argument) {
      value = argument.json;
    } else {
      const form = new FormData();
      for (const [name, entry] of argument.form) {
        form.append(name, entry);
      }
      value = form;
    }
    return value;
  });
}
