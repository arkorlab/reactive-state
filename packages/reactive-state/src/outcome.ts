/**
 * The light entry of what a page, or an error-tracking hook, reads of a server operation's error
 * (`./outcome`): the readers of `runtime/outcome.ts` alone, a module that imports nothing, so a
 * bundle that holds such a hook holds no React and no authority. The digest's builder stays the
 * package's own.
 */
export {
  type OperationOutcome,
  type OperationRefusal,
  operationOutcome,
  operationRefusal,
} from './runtime/outcome.ts';
