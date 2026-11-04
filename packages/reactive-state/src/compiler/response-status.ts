import { literal } from './splice.ts';

/**
 * A guard's response's status, as `new Response(body, init)` makes it of what its init gives: as
 * WebIDL converts an `unsigned short` — `ToNumber`, which throws for a `BigInt` or a symbol; none of
 * a value that is not finite; its fraction cut off; then modulo 2¹⁶ — and thrown for, a `RangeError`,
 * where that is not between 200 and 599 (Fetch's "initialize a response"). `403.5` is 403, and so
 * is 65939; `-1` is 65535, and thrown for.
 */

/** 2¹⁶: what an `unsigned short` is made of a number modulo. */
const UNSIGNED_SHORT = 65_536;
/** The status `new Response` makes where its init's is `undefined`, as where it gives none. */
const DEFAULT_STATUS = 200;
/** The lowest and the highest status `new Response` makes a response of. */
const LOWEST_STATUS = 200;
const HIGHEST_STATUS = 599;

/** What the program throws where a status is none `new Response` makes a response of. */
const OUT_OF_RANGE_THROWN =
  "A guard's response is given a status that is not between 200 and 599, inclusive: ";

/** The status `new Response` makes of `written`, a number; none where it throws for it. */
export function madeStatus(written: number): number | undefined {
  const whole = Number.isFinite(written) ? Math.trunc(written) : 0;
  const status = ((whole % UNSIGNED_SHORT) + UNSIGNED_SHORT) % UNSIGNED_SHORT;
  return status < LOWEST_STATUS || status > HIGHEST_STATUS ? undefined : status;
}

/** The platform's globals the status is made by, as `asStatus` names them. */
export type StatusGlobal = 'Math' | 'Number' | 'RangeError' | 'String';

/**
 * The status `new Response` makes of what the guard computes, as the program makes it as the guard
 * runs — `+` its `ToNumber` — or throws for, as `new Response` throws: what `madeStatus` makes of a
 * number the compile reads; 200 of `undefined`, a member of WebIDL's dictionary it takes as absent. Each of the platform's globals it reads written by the name `named`
 * gives it, the guard's own of its name aside.
 */
export function asStatus(named: (global: StatusGlobal) => string): string {
  const range = `status < ${String(LOWEST_STATUS)} || status > ${String(HIGHEST_STATUS)}`;
  const thrown = `throw new ${named('RangeError')}(${literal(OUT_OF_RANGE_THROWN)} + ${named('String')}(status));`;
  return `((written: number | undefined): number => { if (written === void 0) { return ${String(DEFAULT_STATUS)}; } const number = +written; const whole = ${named('Number')}.isFinite(number) ? ${named('Math')}.trunc(number) : 0; const status = ((whole % ${String(UNSIGNED_SHORT)}) + ${String(UNSIGNED_SHORT)}) % ${String(UNSIGNED_SHORT)}; if (${range}) { ${thrown} } return status; })`;
}
