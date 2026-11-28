import { AuthorityError } from '../authority/errors.ts';
import { isCodeShaped, isReservedCode } from '../refusal-codes.ts';
import { HTTP_UNPROCESSABLE } from '../status.ts';

/**
 * An application's own refusal of a server operation: a code of its own, which a page reads of the
 * refused operation's error (`operationRefusal`), and a message. None of the authority's codes, nor
 * any under the prefixes it names new ones with (`OPERATION_`, `AUTHORITY_`; `refusal-codes.ts`
 * lists them): a page would read the application's refusal as the authority's — a build to reload,
 * a session to sign in again — and a root's render refused by it as the session's end, not the
 * root's own refusal (`PageStore.revoke`).
 */

/**
 * Refuses the server operation under way with `code`, the application's own (422), and `message`
 * — one that names the code where none is given. The refusal is kept for a resend, as
 * `forbidden()`'s is. Thrown once a statement of the application's own tables may have written, it
 * is no refusal: the operation answers that it failed. Thrown wherever else the authority runs the
 * application's code — a component's render, a write's replay, a route's middleware — it refuses
 * that as the authority's other refusals do, with 422 and the code. A code that is no code of the
 * application's own is a fault of the code that names it (`TypeError`).
 */
export function refuse(code: string, message?: string): never {
  if (!isCodeShaped(code)) {
    throw new TypeError(
      `refuse(code): a code is a capital, then capitals, digits or \`_\`, 64 at most: ${code}`,
    );
  }
  if (isReservedCode(code)) {
    throw new TypeError(
      `refuse(code): ${code} is the authority's own code, which a page would read as the authority's refusal: name the application's refusal otherwise.`,
    );
  }
  throw new AuthorityError(message ?? `Refused: ${code}.`, {
    code,
    status: HTTP_UNPROCESSABLE,
  });
}
