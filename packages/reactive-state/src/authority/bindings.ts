import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Json, View as PageView, SiteInputs } from '../program.ts';
import { BUILD_MISMATCH, HTTP_CONFLICT, HTTP_PAYLOAD_TOO_LARGE } from '../status.ts';
import { isJson } from './canonical.ts';
import { AuthorityError, denied, refusal } from './errors.ts';
import type { ComponentStep, Step } from './skeleton.ts';

/**
 * The tokens the authority signs and hands a page through the application: a binding, which lets
 * one session write one field through one state of one component of one page's root, and a
 * subscription, which lets the session follow what the root renders. Each is signed rather than
 * stored, and fixes the target, never the permission: every write renders the root again, along
 * the binding's path, so a binding issued before access was revoked writes nothing after it.
 */

/** A page's root: the component it renders, and the props it renders it with. */
interface RootClaims {
  readonly component: string;
  readonly props: Readonly<Record<string, Json>>;
}

export interface BindingClaims {
  readonly session: string;
  readonly user: string;
  readonly build: string;
  readonly root: RootClaims;
  /**
   * The components from the root to the one whose state it is, the root's own steps left out, with
   * each dynamic site on the way and the inputs it was rendered with.
   */
  readonly path: readonly Step[];
  /** The state's key in that component. */
  readonly key: string;
  /** The field the state bound when the binding was issued. */
  readonly table: string;
  readonly record: string;
  readonly field: string;
  readonly exp: number;
}

export interface SubscriptionClaims {
  readonly session: string;
  readonly build: string;
  readonly root: RootClaims;
  /**
   * The view the page showed, which it follows: the inputs of each dynamic site of each part that
   * showed otherwise than at first — the others as they show at first.
   */
  readonly view: PageView;
  /** What the page showed when it was issued, and the revision it was rendered at. */
  readonly digest: string;
  readonly revision: number;
}

/** What a token is checked against: the session presenting it, the build the authority runs. */
export interface TokenCheck {
  readonly session: string;
  readonly build: string;
}

/** The version of a token's claims, and what each kind of token says it is. */
export const TOKEN_VERSION = 2;
const BINDING = 'binding';
const SUBSCRIPTION = 'subscription';
/** Longer than any token this authority signs; refused before it is parsed. */
const MAX_TOKEN_LENGTH = 4096;
const NAME = /^[A-Za-z]\w{0,63}$/u;
const ID = /^[\w-]{1,64}$/u;
const DIGEST = /^[\da-f]{1,64}$/u;

/**
 * What a token says of its session: a keyed digest of the session's id, never the id. A token is
 * handed to the page's scripts, and the id is the session's `HttpOnly` cookie, which a script that
 * read it could present from anywhere.
 */
export function sessionTag(secret: string, session: string): string {
  return createHmac('sha256', secret).update(`session:${session}`).digest('base64url');
}

export function signed(
  secret: string,
  kind: string,
  claims: Readonly<Record<string, unknown>>,
): string {
  const encoded = Buffer.from(JSON.stringify({ ...claims, t: kind, v: TOKEN_VERSION })).toString(
    'base64url',
  );
  const token = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
  // Never one the authority would refuse to read back: refused for good — a request sent again
  // signs the same — where a page's root has props, or its view inputs, longer than a token carries.
  if (token.length > MAX_TOKEN_LENGTH) {
    throw refusal(
      HTTP_PAYLOAD_TOO_LARGE,
      'TOO_LARGE',
      `A ${kind} would be ${String(token.length)} characters long, more than the authority reads back: render the root with shorter props, or show sites of shorter inputs.`,
    );
  }
  return token;
}

export function signBinding(secret: string, claims: BindingClaims): string {
  return signed(secret, BINDING, { ...claims, session: sessionTag(secret, claims.session) });
}

export function signSubscription(secret: string, claims: SubscriptionClaims): string {
  return signed(secret, SUBSCRIPTION, { ...claims, session: sessionTag(secret, claims.session) });
}

/** The claims of a token this authority signed, each as whatever it is; any other is refused (403). */
export function claimsOf(
  secret: string,
  token: unknown,
): Readonly<Partial<Record<string, unknown>>> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    throw denied();
  }
  const [encoded = '', signature = '', ...rest] = token.split('.');
  const presented = Buffer.from(signature);
  const expected = Buffer.from(createHmac('sha256', secret).update(encoded).digest('base64url'));
  if (
    rest.length > 0 ||
    presented.length !== expected.length ||
    !timingSafeEqual(presented, expected)
  ) {
    throw denied();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  } catch {
    return {};
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Whether `value` is text that `pattern` matches. */
function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rootOf(value: unknown): RootClaims | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const { component, props } = value;
  return typeof component === 'string' && isObject(props) && isJson(props)
    ? { component, props }
    : undefined;
}

/** A site's inputs, as a token carries them: an object of JSON. */
function inputsOf(value: unknown): SiteInputs | undefined {
  return isObject(value) && isJson(value) ? value : undefined;
}

/**
 * One step of a path, as `Step` names one: a component where it stands, or a site and its inputs —
 * and the key of the item of a list.
 */
function stepOf(item: unknown): Step | undefined {
  if (!isObject(item)) {
    return undefined;
  }
  if (Object.hasOwn(item, 's')) {
    const { i, k, s } = item;
    const inputs = inputsOf(i);
    if (typeof s !== 'string' || inputs === undefined) {
      return undefined;
    }
    if (k === undefined) {
      return { i: inputs, s };
    }
    return typeof k === 'string' ? { i: inputs, k, s } : undefined;
  }
  const { c, k, n, p, r } = item;
  if (
    typeof c !== 'string' ||
    typeof r !== 'string' ||
    typeof n !== 'number' ||
    n < 0 ||
    !Number.isSafeInteger(n) ||
    !(k === null || typeof k === 'string') ||
    !(p === undefined || matches(DIGEST, p))
  ) {
    return undefined;
  }
  const step: ComponentStep = { c, k, n, r, ...(p !== undefined && { p }) };
  return step;
}

function stepsOf(value: unknown): readonly Step[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: Step[] = [];
  for (const item of value as readonly unknown[]) {
    const step = stepOf(item);
    if (step === undefined) {
      return undefined;
    }
    steps.push(step);
  }
  return steps;
}

/** A view, as a subscription carries it: the inputs of each site, by instance and site. */
function viewOf(value: unknown): PageView | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  for (const entry of Object.values(value)) {
    if (!isObject(entry) || Object.values(entry).some((inputs) => inputsOf(inputs) === undefined)) {
      return undefined;
    }
  }
  return value as PageView;
}

/**
 * The claims every token of `kind` is checked for first: signed by this authority, of this kind,
 * for the session presenting it (403 otherwise); for the build the authority runs (409,
 * `BUILD_MISMATCH`, otherwise: a page of another build, which a reload brings up to this one,
 * whatever version of the claims its token holds); and of this version of them (403 otherwise).
 */
function checked(
  secret: string,
  token: unknown,
  kind: string,
  check: TokenCheck,
): Readonly<Partial<Record<string, unknown>>> {
  const claims = claimsOf(secret, token);
  if (claims['t'] !== kind || claims['session'] !== sessionTag(secret, check.session)) {
    throw denied();
  }
  if (claims['build'] !== check.build) {
    throw new AuthorityError('The application was updated. Reload the page.', {
      code: BUILD_MISMATCH,
      status: HTTP_CONFLICT,
    });
  }
  if (claims['v'] !== TOKEN_VERSION) {
    throw denied();
  }
  return claims;
}

/**
 * The claims of a binding this authority signed for the session presenting it and its user, before
 * it expired, for the build it runs; a refusal (403, or 409 for another build) otherwise.
 */
export function verifyBinding(
  secret: string,
  token: unknown,
  check: TokenCheck & { readonly user: string; readonly now: number },
): BindingClaims {
  const claims = checked(secret, token, BINDING, check);
  const { exp, field, key, record, table, user } = claims;
  const root = rootOf(claims['root']);
  const path = stepsOf(claims['path']);
  if (
    root === undefined ||
    path === undefined ||
    typeof key !== 'string' ||
    typeof exp !== 'number' ||
    exp <= check.now ||
    user !== check.user ||
    !matches(NAME, table) ||
    !matches(ID, record) ||
    !matches(NAME, field)
  ) {
    throw denied();
  }
  return {
    build: check.build,
    exp,
    field,
    key,
    path,
    record,
    root,
    session: check.session,
    table,
    user,
  };
}

/** The claims of a subscription this authority signed for the session presenting it. */
export function verifySubscription(
  secret: string,
  token: unknown,
  check: TokenCheck,
): SubscriptionClaims {
  const claims = checked(secret, token, SUBSCRIPTION, check);
  const { digest, revision } = claims;
  const root = rootOf(claims['root']);
  const view = viewOf(claims['view']);
  if (
    root === undefined ||
    view === undefined ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    !matches(DIGEST, digest)
  ) {
    throw denied();
  }
  return { build: check.build, digest, revision, root, session: check.session, view };
}
