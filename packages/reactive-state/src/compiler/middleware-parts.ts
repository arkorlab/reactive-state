import {
  type Identifier,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isForOfStatement,
  isIdentifier,
  isIfStatement,
  isMetaProperty,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableStatement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { checkComputedOnce, checkContextDefaults } from './middleware-alike.ts';
import { checkBeforeGuard, checkResources } from './middleware-order.ts';
import {
  contextReads,
  declaredBy,
  type MiddlewareNames,
  patternReads,
  placeOf,
  readsAnyOf,
  requestRead,
  type StatementReads,
  unionOf,
} from './middleware-reads.ts';
import { checkReassigned } from './middleware-reassigned.ts';
import { type GuardAnswers, guardAnswers } from './middleware-response.ts';
import type { ModuleKind } from './modules.ts';
import { checkServerNode } from './prefix.ts';
import { isFunctionLike } from './reach.ts';
import { byCodeUnits } from './splice.ts';
import { isConstant } from './statements.ts';

/**
 * A route middleware's statements, told apart: the guard the authority runs, what the host
 * computes of the request before `next`, and what it does to the response after it. A constant of
 * the params alone — one that reads neither the request, nor an input nothing tracks, nor anything
 * only the guard has — is written into each part that reads it: computed again of the same params,
 * it is the same value there. One both the guard and the host read is so only where it is made of
 * literals and the params alone (`middleware-alike.ts`), and refused otherwise: a call, an import
 * or a global each would compute or read as its own.
 */

/** What the guard's program reads the platform's globals off where the guard names its own of them. */
const GLOBAL_THIS = 'globalThis';
const GLOBAL_THIS_IMPORTED =
  "The guard reads an import of its own named `globalThis`, which its program would read the platform's globals off in place of the platform's own — `Headers`, `TypeError`, a name of which the middleware declares too: import it by another name.";

/** One part of a middleware as an output writes it: its statements, in order, and what they read. */
export interface Part {
  readonly statements: readonly Statement[];
  /** The middleware's names its statements read at run time. */
  readonly values: ReadonlySet<string>;
  /** The middleware's names a type in them reads. */
  readonly types: ReadonlySet<string>;
  /** The context's names the part reads. */
  readonly context: readonly string[];
  /** Whether they await, outside the functions they hold. */
  readonly awaits: boolean;
}

interface GuardPart extends GuardAnswers, Part {
  /** A global the guard reads that nothing tracks, the first. */
  readonly untracked: string | undefined;
}

interface EnvelopePart extends Part {
  /** What the part before `next` answers the part after it, by name: its constants, the context's names. */
  readonly locals: readonly string[];
}

interface AfterPart extends EnvelopePart {
  /** The response `next` answered, as the middleware names it. */
  readonly response: Identifier;
}

export interface MiddlewareParts {
  readonly guard: GuardPart | undefined;
  readonly before: EnvelopePart | undefined;
  readonly after: AfterPart | undefined;
}

/** What a statement before `next` is: the guard's, the envelope's, or a constant of the params alone. */
type Role = 'envelope' | 'guard' | 'pure';

interface Read {
  readonly statement: Statement;
  readonly reads: StatementReads;
  readonly declares: readonly string[];
}

interface Classified extends Read {
  readonly role: Role;
}

/** The modules only the guard reads: what runs on the authority alone. */
const AUTHORITY_ONLY: ReadonlySet<ModuleKind> = new Set(['operations', 'server']);

/** The modules no part of a middleware reads at run time: what renders, or runs in the browser. */
const RENDERED: ReadonlySet<ModuleKind> = new Set(['client', 'component', 'hooks']);

/** React's and Next.js's modules, which the authority — where a guard runs — runs none of. */
const ELEMENT: ReadonlySet<ModuleKind> = new Set(['element']);

const GUARD_REQUEST =
  "the guard — what the middleware runs before `next` that reads the database or the session, or depends on what does — reads the request: the authority runs it again with the route's params alone, wherever the route's preconditions are checked (a render, a write, an event stream), where no request is. Read the request in a `const` of its own, outside the guard, and the context's `params` alone in it.";

const RUN_TIME_IMPORT =
  'A route middleware imports nothing at run time, nor reads its own URL: its parts are written elsewhere, where a relative path names another module. Import the module beside its other imports.';

const AFTER_SHAPE =
  "After `await next()`, a route middleware reads and sets the response's headers — `response.headers.set(…)`, `.append(…)`, `.delete(…)`, with `const`s and `if`s of its own — and ends with `return response;`: the body is the route's, which may be one artifact every visitor is answered with.";

const NO_READS: StatementReads = { types: new Set(), untracked: undefined, values: new Map() };

function kindOf(name: string, names: MiddlewareNames): ModuleKind | undefined {
  const binding = names.imports.get(name);
  return binding === undefined || binding.typeOnly ? undefined : binding.module.target.kind;
}

/** The first import of `kinds` that `reads` reads at run time. */
function importRead(
  reads: StatementReads,
  names: MiddlewareNames,
  kinds: ReadonlySet<ModuleKind>,
): string | undefined {
  for (const name of reads.values.keys()) {
    const kind = kindOf(name, names);
    if (kind !== undefined && kinds.has(kind)) {
      return name;
    }
  }
  return undefined;
}

function isConstStatement(statement: Statement, sourceFile: SourceFile): boolean {
  return isVariableStatement(statement) && isConstant(statement, sourceFile);
}

/** What a statement before `next` is, given what the ones before it were. */
function roleOf(
  read: Read,
  names: MiddlewareNames,
  declared: { readonly guard: ReadonlySet<string>; readonly envelope: ReadonlySet<string> },
): Role {
  const { reads, statement } = read;
  if (
    !isConstStatement(statement, names.sourceFile) ||
    importRead(reads, names, AUTHORITY_ONLY) !== undefined ||
    readsAnyOf(reads, declared.guard) !== undefined
  ) {
    return 'guard';
  }
  if (
    requestRead(reads, names.context) !== undefined ||
    reads.untracked !== undefined ||
    readsAnyOf(reads, declared.envelope) !== undefined
  ) {
    return 'envelope';
  }
  return 'pure';
}

/** What each statement before `next` is, in order. */
function classify(prefix: readonly Read[], names: MiddlewareNames): readonly Classified[] {
  const declared = { envelope: new Set<string>(), guard: new Set<string>() };
  return prefix.map((read): Classified => {
    const role = roleOf(read, names, declared);
    if (role !== 'pure') {
      for (const name of read.declares) {
        declared[role].add(name);
      }
    }
    return { ...read, role };
  });
}

/** The constants of the params alone that `seeds` read, and each of them they read in turn. */
function closureOf(
  seeds: readonly StatementReads[],
  pure: readonly Classified[],
): ReadonlySet<Classified> {
  const included = new Set<Classified>();
  const pending = [...seeds];
  for (let reads = pending.pop(); reads !== undefined; reads = pending.pop()) {
    const { types, values } = reads;
    for (const each of pure) {
      if (
        !included.has(each) &&
        each.declares.some((name) => values.has(name) || types.has(name))
      ) {
        included.add(each);
        pending.push(each.reads);
      }
    }
  }
  return included;
}

/** Refuses an import made at run time anywhere in the middleware, and its module's own URL. */
function checkRunTime(nodes: readonly Node[], names: MiddlewareNames): void {
  const visit = (node: Node): void => {
    if (
      (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) ||
      (isMetaProperty(node) && node.keywordToken === SyntaxKind.ImportKeyword)
    ) {
      names.fail(RUN_TIME_IMPORT, node);
    }
    node.forEachChild(visit);
  };
  for (const node of nodes) {
    visit(node);
  }
}

/** What a check reads of a statement, or of a default of the context's pattern: what it reads, where. */
type Checked = Pick<Read, 'reads'> & { readonly statement: Node };

/** Refuses what no part of a middleware reads: a component, a Client Component, a hook. */
function checkRendered(read: Pick<Read, 'reads'>, names: MiddlewareNames): void {
  const name = importRead(read.reads, names, RENDERED);
  if (name !== undefined) {
    names.fail(
      `\`${name}\` is a component, a Client Component or a hook, which a route middleware does not run: it runs on the server, around the route that renders them.`,
      placeOf(read.reads, name),
    );
  }
}

/** Refuses a guard's statement that reads what the authority does not have where it runs it. */
function checkGuard(read: Checked, names: MiddlewareNames, envelope: ReadonlySet<string>): void {
  const request = requestRead(read.reads, names.context);
  if (request !== undefined) {
    names.fail(`Where it reads \`${request.text}\`, ${GUARD_REQUEST}`, request);
  }
  const computed = readsAnyOf(read.reads, envelope);
  if (computed !== undefined) {
    names.fail(
      `The guard reads \`${computed}\`, which the middleware computes of the request — the host's, once for each request — and which the authority, running the guard again with the route's params alone, does not have: compute it in the guard of the params, or read it after \`next\`.`,
      placeOf(read.reads, computed),
    );
  }
  const element = importRead(read.reads, names, ELEMENT);
  if (element !== undefined) {
    names.fail(
      `The guard reads \`${element}\`, of React's or Next.js's, which the authority — where the guard runs — does not run: refuse with \`forbidden()\` of \`@arkorlab/reactive-state/server\`, or answer \`new Response(…)\`.`,
      placeOf(read.reads, element),
    );
  }
  checkRendered(read, names);
  const visit = (node: Node): void => {
    checkServerNode(node, names.declared, names.fail);
    node.forEachChild(visit);
  };
  visit(read.statement);
}

/** Whether `identifier`, the response, is read as `response.headers`. */
function readsHeaders(identifier: Identifier): boolean {
  const { parent } = identifier;
  return (
    isPropertyAccessExpression(parent) &&
    parent.expression === identifier &&
    parent.name.text === 'headers'
  );
}

/** Whether `statement`, after `next`, is of the forms an after part is written in. */
function isAfterShape(statement: Statement, response: string, sourceFile: SourceFile): boolean {
  if (isExpressionStatement(statement)) {
    // `response.headers.set(…)`: a call of a method of the headers.
    const call = statement.expression;
    const method = isCallExpression(call) ? call.expression : undefined;
    const headers =
      method !== undefined && isPropertyAccessExpression(method) ? method.expression : undefined;
    const target =
      headers !== undefined && isPropertyAccessExpression(headers) ? headers.expression : undefined;
    return target !== undefined && isIdentifier(target) && target.text === response;
  }
  if (isConstStatement(statement, sourceFile)) {
    return true;
  }
  if (isBlock(statement)) {
    return statement.statements.every((each) => isAfterShape(each, response, sourceFile));
  }
  return (
    isIfStatement(statement) &&
    isAfterShape(statement.thenStatement, response, sourceFile) &&
    (statement.elseStatement === undefined ||
      isAfterShape(statement.elseStatement, response, sourceFile))
  );
}

/** Refuses an after part's statement that does more than work on the headers, or reads what it has not. */
function checkAfter(read: Read, names: MiddlewareNames, around: Around): void {
  const { reads, statement } = read;
  const response = around.response.text;
  if (!isAfterShape(statement, response, names.sourceFile)) {
    names.fail(AFTER_SHAPE, statement);
  }
  const body = reads.values.get(response)?.find((identifier) => !readsHeaders(identifier));
  if (body !== undefined) {
    names.fail(AFTER_SHAPE, body);
  }
  const guarded = readsAnyOf(reads, around.guard) ?? importRead(reads, names, AUTHORITY_ONLY);
  if (guarded !== undefined) {
    names.fail(
      `After \`next\`, the middleware reads \`${guarded}\`, which is the guard's — what the authority runs — and which the host, running what comes after \`next\` for each request, does not have: read the database and the session before \`next\` alone.`,
      placeOf(reads, guarded),
    );
  }
  checkRendered(read, names);
}

/** Whether `statements` await, outside the functions they hold. */
function awaitsIn(statements: readonly Statement[]): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || isFunctionLike(node)) {
      return;
    }
    found =
      node.kind === SyntaxKind.AwaitExpression ||
      (isForOfStatement(node) && node.awaitModifier !== undefined);
    node.forEachChild(visit);
  };
  for (const statement of statements) {
    visit(statement);
  }
  return found;
}

/** A part of `reads`, in the order the middleware holds them. */
function partOf(reads: readonly Read[], names: MiddlewareNames): Part {
  const values = new Set(reads.flatMap((read) => [...read.reads.values.keys()]));
  const types = new Set(reads.flatMap((read) => [...read.reads.types]));
  const statements = reads.map((read) => read.statement);
  return {
    awaits: awaitsIn(statements),
    context: contextReads(values, names.context),
    statements,
    types,
    values,
  };
}

/** In the order the middleware holds them. */
function inOrder<T extends Read>(reads: Iterable<T>): readonly T[] {
  return [...new Set(reads)].toSorted((a, b) => a.statement.pos - b.statement.pos);
}

/** What the after part is checked against: the response, and the guard's names. */
interface Around {
  readonly response: Identifier;
  readonly guard: ReadonlySet<string>;
}

/** Refuses an after part that does not end by returning the response `next` answered. */
function checkEnding(after: readonly Read[], response: Identifier, names: MiddlewareNames): void {
  const last = after.at(-1)?.statement;
  const returned = last !== undefined && isReturnStatement(last) ? last.expression : undefined;
  if (returned === undefined || !isIdentifier(returned) || returned.text !== response.text) {
    names.fail(AFTER_SHAPE, last ?? response);
  }
}

export interface Assembling {
  readonly names: MiddlewareNames;
  readonly statements: readonly Statement[];
  readonly reads: readonly StatementReads[];
  readonly split: { readonly index: number; readonly response: Identifier | undefined };
}

/** The statements before `next` and after it, told apart, and checked. */
interface Sorted {
  readonly all: readonly Read[];
  readonly classified: readonly Classified[];
  readonly suffix: readonly Read[];
}

/** A statement, with what it reads and declares. */
function readOf(statement: Statement, reads: StatementReads | undefined): Read {
  return { declares: declaredBy(statement), reads: reads ?? NO_READS, statement };
}

function sortedOf(assembling: Assembling): Sorted {
  const { names, reads, split, statements } = assembling;
  const all = statements.map((statement, index) => readOf(statement, reads[index]));
  const classified = classify(all.slice(0, split.index), names);
  const { response } = split;
  if (response === undefined) {
    return { all, classified, suffix: [] };
  }
  // What follows `const response = await next()`, but the `return response;` that ends it.
  const after = all.slice(split.index + 1);
  checkEnding(after, response, names);
  return { all, classified, suffix: after.slice(0, -1) };
}

/** The guard, and the envelope's parts before and after `next`, of a middleware split at `split`. */
export function assembleParts(assembling: Assembling): MiddlewareParts {
  const { names, split, statements } = assembling;
  checkRunTime(statements, names);
  if (split.index < 0) {
    return { after: undefined, before: undefined, guard: undefined };
  }
  checkResources(statements.slice(0, split.index), names);
  const { classified, suffix } = sortedOf(assembling);
  const of = (role: Role): readonly Classified[] => classified.filter((each) => each.role === role);
  const [pure, guards, envelopes] = [of('pure'), of('guard'), of('envelope')];
  const inGuard = closureOf(
    guards.map((each) => each.reads),
    pure,
  );
  const hostSeeds = [...envelopes, ...suffix];
  const readByHost = closureOf(
    hostSeeds.map((each) => each.reads),
    pure,
  );
  // A constant of the params alone that nothing reads runs where the request is, as written, and
  // the constants it reads are written there as well.
  const unread = pure.filter((each) => !inGuard.has(each) && !readByHost.has(each));
  const elsewhere = closureOf(
    [...hostSeeds, ...unread].map((each) => each.reads),
    pure,
  );
  const hostReads = unionOf(
    ...[...hostSeeds, ...elsewhere].map((each) => each.reads.values.keys()),
  );
  const before = inOrder([...envelopes, ...elsewhere, ...unread]);
  const guardReads = inOrder([...guards, ...inGuard]);
  checkReassigned(
    {
      guard: guardReads.map((each) => each.statement),
      host: before.map((each) => each.statement),
      hostReads,
    },
    names,
  );
  // What both read is written into both: only what each computes alike.
  checkComputedOnce(
    pure,
    {
      both: (each) => inGuard.has(each) && elsewhere.has(each),
      host: (name) => hostSeeds.some((each) => each.reads.values.has(name)),
    },
    names.context,
    names.fail,
  );
  const envelopeNames = new Set(envelopes.flatMap((each) => each.declares));
  for (const read of guardReads) {
    checkGuard(read, names, envelopeNames);
  }
  const outsideGuard = [...envelopes, ...pure];
  for (const read of outsideGuard) {
    checkRendered(read, names);
  }
  const guardNames = new Set(guards.flatMap((each) => each.declares));
  const { response } = split;
  if (response !== undefined) {
    for (const read of suffix) {
      checkAfter(read, names, { guard: guardNames, response });
    }
  }
  checkBeforeGuard(
    before.map((each) => each.statement),
    guards.map((each) => each.statement),
    names,
  );
  const locals = localsOf(suffix, before, names);
  const parts: MiddlewareParts = {
    after:
      response === undefined || suffix.length === 0
        ? undefined
        : { ...partOf(suffix, names), locals, response },
    before:
      before.length === 0 && locals.length === 0 ? undefined : beforeOf(before, locals, names),
    guard: guards.length === 0 ? undefined : guardOf(guardReads, names, envelopeNames),
  };
  // What both bind of the context — a default holding a name each reads — only defaults each computes alike.
  checkContextDefaults(
    names.context,
    {
      guard: (name) => parts.guard?.context.includes(name) === true,
      host: (name) => parts.before?.context.includes(name) === true,
    },
    names.fail,
  );
  return parts;
}

/**
 * `part`, binding as well what the context's pattern runs where the part binds names of it — each
 * default and computed key its copy of the pattern holds, and the context's names they read in turn
 * (`patternReads`) — each checked by `check` as a statement of the part is: it runs where the part
 * runs. What they read, besides.
 */
function withPattern<T extends Part>(
  part: T,
  names: MiddlewareNames,
  check: (read: Checked) => void,
): { readonly part: T; readonly reads: readonly StatementReads[] } {
  const pattern = patternReads(part.context, names);
  for (const [statement, reads] of pattern.reads) {
    check({ reads, statement });
  }
  const reads = [...pattern.reads.values()];
  return {
    part: {
      ...part,
      context: [...pattern.context],
      types: unionOf(part.types, ...reads.map((each) => each.types)),
      values: unionOf(part.values, ...reads.map((each) => each.values.keys())),
    },
    reads,
  };
}

function guardOf(
  statements: readonly Read[],
  names: MiddlewareNames,
  envelope: ReadonlySet<string>,
): GuardPart {
  const { part, reads: defaults } = withPattern(partOf(statements, names), names, (read) => {
    checkGuard(read, names, envelope);
  });
  const reads = [...statements.map((read) => read.reads), ...defaults];
  const local = (name: string): boolean =>
    names.names.topLevel.has(name) || names.declared.has(name);
  const answered = guardAnswers(part.statements, names.sourceFile, { fail: names.fail, local });
  // The program binds a global the guard has a name of its own for by `globalThis`, at its top
  // level, which an import of that name the program keeps would be in place of.
  const shadowing = names.imports.get(GLOBAL_THIS);
  const kept = part.values.has(GLOBAL_THIS) || part.types.has(GLOBAL_THIS);
  if (shadowing !== undefined && kept && answered.globals.size > 0) {
    names.fail(GLOBAL_THIS_IMPORTED, shadowing.name);
  }
  return {
    ...part,
    ...answered,
    untracked: reads.find((read) => read.untracked !== undefined)?.untracked,
  };
}

/** What the part after `next` reads of the part before it: its constants, and the context's names. */
function localsOf(
  suffix: readonly Read[],
  before: readonly Read[],
  names: MiddlewareNames,
): readonly string[] {
  const read = unionOf(...suffix.map((each) => each.reads.values.keys()));
  const locals = unionOf(contextReads(read, names.context));
  for (const each of before) {
    for (const name of each.declares) {
      if (read.has(name)) {
        locals.add(name);
      }
    }
  }
  return [...locals].toSorted(byCodeUnits);
}

/** The part before `next` the host runs: the envelope's constants, and those of the params it needs. */
function beforeOf(
  before: readonly Read[],
  locals: readonly string[],
  names: MiddlewareNames,
): EnvelopePart {
  const part = partOf(before, names);
  // The context's names the part after `next` reads, which the part before it hands on.
  const handed = contextReads(locals, names.context);
  const envelope = { ...part, context: [...unionOf(part.context, handed)], locals };
  return withPattern(envelope, names, (read) => {
    checkEnvelopeDefault(read, names);
  }).part;
}

/**
 * Refuses a default of the context's pattern the host binds — before `next`, for each request —
 * that imports at run time or reads its module's URL, as a statement of the middleware may not, that
 * reads what runs on the authority alone, or that renders: a statement that reads either of the last
 * two is the guard's, or refused, and a default is bound where the part that reads its name runs.
 */
function checkEnvelopeDefault(read: Checked, names: MiddlewareNames): void {
  checkRunTime([read.statement], names);
  const authority = importRead(read.reads, names, AUTHORITY_ONLY);
  if (authority !== undefined) {
    names.fail(
      `A default of the route middleware's context reads \`${authority}\`, which runs on the authority alone, where the host binds it — before \`next\`, for each request — as what the host runs reads its name: give a name the host reads no such default, or read it in the guard alone.`,
      placeOf(read.reads, authority),
    );
  }
  checkRendered(read, names);
}
