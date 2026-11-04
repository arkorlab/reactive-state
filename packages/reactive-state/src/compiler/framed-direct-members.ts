import type { Expression, Node } from 'typescript/ast';

import { framedArgumentMember } from './framed-argument-members.ts';
import { framedArrayFromResult } from './framed-array-from-results.ts';
import { framedHeldMember } from './framed-held-members.ts';
import { framedJsonReviverResult } from './framed-json-reviver-results.ts';
import { framedMappedMemberResult } from './framed-mapped-member-results.ts';
import { framedObjectMember } from './framed-object-members.ts';
import { framedObjectThisMember } from './framed-object-this.ts';
import { framedProxyGetMember } from './framed-proxy-get-results.ts';

/**
 * Source-written object, arguments and literal this members, what a Proxy's written get trap
 * returns, and what a variable or a construction holds on a member path retain their original
 * selected values.
 */

export function framedDirectMember(
  value: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
  point?: Node,
): boolean {
  return (
    framedObjectMember(value, keys, error) ||
    framedArgumentMember(value, keys, error) ||
    framedObjectThisMember(value, keys, error) ||
    framedJsonReviverResult(value, keys, error) === true ||
    framedArrayFromResult(value, keys, error) ||
    framedMappedMemberResult(value, keys, error) ||
    framedProxyGetMember(value, keys, error, point) ||
    framedHeldMember(value, keys, error, point)
  );
}
