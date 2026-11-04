import { createHash } from 'node:crypto';

import {
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSpreadElement,
  isTaggedTemplateExpression,
  isTemplateSpan,
  type Node,
  type SourceFile,
  SyntaxKind,
  type TaggedTemplateExpression,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import type { Fail } from './errors.ts';
import { committedAttributeOf, handlerAttributeOf, isComponentHandlerValue } from './handlers.ts';
import { functionOf } from './statements.ts';
import { readUpdate, type Update, type UpdateScope } from './update.ts';
import { writtenKey } from './writer-bindings.ts';
import { heldWriters, writerValue } from './writer-values.ts';

/**
 * What a setter of a state the authority may hold writes. The authority never runs code the browser
 * sends: a write names an update registered at compile time, and the authority runs that — of the
 * field's current value and of the values the call captured — or, for a `set`, checks the value the
 * browser sends against the field before it writes it.
 *
 * - An update the compiler can see — `setEstimate(current => addEstimate(current, step))`, a
 *   function written where it is called, or a constant function given by name — is registered as
 *   it is (`apply`): the authority runs its copy, and the browser runs its own only to predict the
 *   result, `setEstimate.compiled("u_…", { step }, current => addEstimate(current, step))`.
 * - Any other value (`setTitle(event.target.value)`), and the setter handed on as it is
 *   (`onChange={setTitle}`), write the state's `set`, and are left as written.
 *
 * A setter is called from the handler of an event a person's action dispatches alone — or from a
 * constant function, or a custom hook's function, that is called from one, or given to one, alone:
 * called as the JSX is built or committed, or from an event that fires as it is, it would write
 * again on every render a write brings.
 */

/** The length of an updater id's hash: enough that two updaters never share one. */
const ID_HASH_LENGTH = 20;

/** A setter of a state the authority may hold, as the code that holds it names the state. */
export interface Setter {
  /** The state's key, in the code that holds the setter: `title`, `useEstimate#0.estimate`. */
  readonly key: string;
  /** What an update written in this code is registered under: its owner's name for the state. */
  readonly site: string;
  /** The id of the state's `set`, which the code that declares the state owns. */
  readonly set: string;
  /**
   * The type of the state's value, as the authority's program writes it; none where a program says
   * it of its own, by its `States`.
   */
  readonly type: string | undefined;
  /**
   * Whether the state is local: its setter is React's, which the page alone applies — called, as
   * any setter is, from a handler alone, but registering nothing.
   */
  readonly local?: boolean;
}

/** What a local state's setter writes, as what a function writes holds it: registered by nothing. */
const UNREGISTERED = '';

/** Whether `uses` write local states alone, which nothing registers. */
function writesLocal(uses: Uses): boolean {
  for (const id of uses.keys()) {
    if (id !== UNREGISTERED) {
      return false;
    }
  }
  return true;
}

/** What a function writes when it is called: each updater it runs, with the keys it writes. */
export type Uses = ReadonlyMap<string, readonly string[]>;

/** An update registered as a function of the current value and of what its call captured. */
export interface ApplySite {
  readonly kind: 'apply';
  readonly id: string;
  readonly update: Update;
  /** The type of the state's value, as the authority's program writes it; see `Setter.type`. */
  readonly type: string | undefined;
}

/** The registered `set` of a state, which writes the value the browser sends. */
interface SetSite {
  readonly kind: 'set';
  readonly id: string;
}

export type UpdaterSite = ApplySite | SetSite;

/** The code whose writes are read: a component's browser part, or a custom hook. */
export interface Owner extends UpdateScope {
  /** Whose updates they are: a component's id, or a hook's module id and name. */
  readonly id: string;
  readonly sourceFile: SourceFile;
  readonly declaration: FunctionDeclaration;
  readonly names: ReadonlyMap<string, TopLevel>;
  /** Every read of each top-level name in the owner's browser code. */
  readonly reads: ReadonlyMap<string, readonly Identifier[]>;
  /** What a hook returns, item by item, which its callers read; nothing for a component. */
  readonly items: ReadonlyMap<string, Node>;
  /** The setters it holds of states the authority may hold, by name. */
  readonly setters: ReadonlyMap<string, Setter>;
  /** The names it holds of a custom hook's functions that write, by name, with what they write. */
  readonly writing: ReadonlyMap<string, Uses>;
  /** The updaters of the custom hooks it calls, by id. */
  readonly sites: ReadonlyMap<string, UpdaterSite>;
  readonly fail: Fail;
}

/** An updater, with the keys of the states it writes. */
export interface Registered {
  readonly site: UpdaterSite;
  readonly keys: ReadonlySet<string>;
}

export interface Writes {
  /** Each updater the owner's code writes with, by id, with the keys it writes. */
  readonly updaters: ReadonlyMap<string, Registered>;
  /** Each call of a setter that registered an update, and the update. */
  readonly calls: ReadonlyMap<CallExpression, ApplySite>;
  /** What calling a function the code holds writes: a constant, or one a hook returns. */
  readonly usesOf: (fn: ArrowFunction | FunctionExpression) => Uses;
  /** What calling a constant function writes, by its name. */
  readonly constants: ReadonlyMap<string, ArrowFunction | FunctionExpression>;
}

/** The id of an updater: `u_` and a hash of its owner, the state it writes and what it computes. */
export function updaterId(owner: string, site: string, form: string): string {
  const hash = createHash('sha256').update(`${owner}:${site}:${form}`).digest('hex');
  return `u_${hash.slice(0, ID_HASH_LENGTH)}`;
}

const HANDLER_ONLY =
  "from the handler of an event a person's action dispatches — `onClick={() => …}`, `onChange`, `onSubmit` — or from a constant function called from one, or given to one, alone: called as the JSX is built or committed, or from an event that fires as it is — `onLoad`, `onError`, `onFocus`, `onScroll` — it would write again on every render a write brings.";

class WriteReader {
  readonly #owner: Owner;
  readonly #fail: Fail;
  readonly #updaters = new Map<string, { site: UpdaterSite; keys: Set<string> }>();
  readonly #calls = new Map<CallExpression, ApplySite>();
  readonly #constants: ReadonlyMap<string, ArrowFunction | FunctionExpression>;
  readonly #uses = new Map<Expression, Uses>();

  constructor(owner: Owner) {
    this.#owner = owner;
    this.#fail = owner.fail;
    this.#constants = constantFunctions(owner.names);
  }

  /** What a read of a top-level name writes, where it writes at all, and whether it may. */
  #reference(name: string, reference: Identifier): void {
    this.#checkCompiledReference(reference);
    const setter = this.#owner.setters.get(name);
    if (setter !== undefined) {
      this.#setterReference(reference, setter);
      return;
    }
    const constant = this.#constants.get(name);
    const value = writerValue(reference, this.#owner.names);
    const uses = this.#usesOf(value);
    if (uses.size === 0) {
      return;
    }
    const call = callOf(value, this.#owner.names);
    // What writes local states alone is React's to hand on, wherever a value goes — but to what
    // React calls itself as the element commits; called as the JSX is built, it would write again on
    // every render all the same.
    const local = writesLocal(uses);
    if (call === undefined && local) {
      this.#checkCommitted(reference);
      this.#checkHanded(reference);
    }
    const may =
      call === undefined
        ? local ||
          handlerAttributeOf(value) !== undefined ||
          this.#isItem(reference) ||
          this.#inHandler(reference)
        : this.#inHandler(call);
    if (!may) {
      this.#fail(
        `\`${reference.text}\` writes a state, so it is called, or handed on, ${HANDLER_ONLY}`,
        reference,
      );
    }
    // A constant's own reads of the setters are registered where they are read; a hook's function
    // registers what it writes here, where it is called.
    if (constant === undefined) {
      for (const [id, keys] of uses) {
        for (const key of keys) {
          this.#register(this.#owner.sites.get(id) ?? { id, kind: 'set' }, key);
        }
      }
    }
  }

  /** A setter's compiled entry point belongs to emitted code, never application member reads. */
  #checkCompiledReference(reference: Identifier): void {
    for (let node: Node = reference; node !== this.#owner.declaration; node = node.parent) {
      let key: string | undefined;
      if (isPropertyAccessExpression(node)) {
        key = node.name.text;
      } else if (isElementAccessExpression(node)) {
        key = writtenKey(node.argumentExpression, this.#owner.names);
      }
      if (
        key === 'compiled' &&
        (isPropertyAccessExpression(node) || isElementAccessExpression(node)) &&
        heldWriters(node.expression, this.#owner.names).some(
          (writer) => isIdentifier(writer) && this.#owner.setters.has(writer.text),
        )
      ) {
        this.#fail("A setter's `.compiled` member is the compiler's to write.", node);
      }
    }
  }

  #setterReference(reference: Identifier, setter: Setter): void {
    const { parent } = reference;
    if (isCallExpression(parent) && parent.expression === reference) {
      if (!this.#inHandler(parent)) {
        this.#fail(`The setter is called ${HANDLER_ONLY}`, parent);
      }
      if (setter.local === true) {
        return;
      }
      const site = this.#updateOf(parent, setter);
      this.#register(site, setter.key);
      if (site.kind === 'apply') {
        this.#calls.set(parent, site);
      }
      return;
    }
    if (setter.local === true) {
      this.#localSetterReference(reference);
      return;
    }
    if (
      ((isPropertyAccessExpression(parent) ||
        isElementAccessExpression(parent) ||
        isNewExpression(parent)) &&
        parent.expression === reference) ||
      (isTaggedTemplateExpression(parent) && parent.tag === reference)
    ) {
      this.#fail(
        `\`${reference.text}\` is called with parentheses, or passed on as it is, and nothing else: what it holds is the compiler's to write.`,
        parent,
      );
    }
    if (this.#isItem(reference)) {
      // A hook's setter, returned: what its callers do with it is theirs to register.
      return;
    }
    // Anywhere else — under another name, as an argument, in an array — it could be called while the
    // JSX is built, past the check on its calls above, and write again on every render a write brings.
    if (!this.#inHandler(reference) && !isComponentHandlerValue(reference)) {
      this.#fail(
        `\`${reference.text}\` is called from the handler of an event a person's action dispatches, or handed as it is to such an attribute of a component's — \`onChange={${reference.text}}\` — and read nowhere else: under another name, or as a value, it could be called as the JSX is built.`,
        reference,
      );
    }
    this.#register({ id: setter.set, kind: 'set' }, setter.key);
  }

  /**
   * A local state's setter, React's, handed on as React's is, wherever a value goes — but to what
   * React calls itself as the element commits (`#checkCommitted`), and to a call as the JSX is built
   * (`#checkHanded`) — and called through `.call`, `.apply` or as a tag, as a call of it is, from a
   * handler alone.
   */
  #localSetterReference(reference: Identifier): void {
    const value = writerValue(reference, this.#owner.names);
    if (value !== reference && this.#usesOf(value).size === 0) {
      return;
    }
    const call = callOf(value, this.#owner.names);
    if (call === undefined) {
      this.#checkCommitted(reference);
      this.#checkHanded(reference);
    } else if (!this.#inHandler(call)) {
      this.#fail(`The setter is called ${HANDLER_ONLY}`, call);
    }
  }

  /**
   * Refuses a function that writes a state given to what React calls itself as the element
   * commits, with nobody doing anything (`committedAttributeOf`): `ref`, which it calls again on
   * each commit it is given a new function on, as a constant function's is on every render, and an
   * event of an element of the browser's that fires by itself, `onLoad`.
   */
  #checkCommitted(reference: Identifier): void {
    const attribute = committedAttributeOf(writerValue(reference, this.#owner.names));
    if (attribute !== undefined) {
      this.#fail(
        `\`${reference.text}\` writes a state, and React calls what \`${attribute}\` is given itself, as the element commits — a ref again on each commit it is a new function on, as a constant function's is on every render — with nobody doing anything: it is called, or handed on, ${HANDLER_ONLY}`,
        reference,
      );
    }
  }

  /**
   * Refuses a function that writes a local state given to a call as the JSX is built — an argument
   * of it, what a spread there hands, a substitution of a tag's (`handedToCall`) — which may call
   * it then, `items.map(setShown)`, and write again on every render a write brings; within a
   * handler, the call is the handler's.
   */
  #checkHanded(reference: Identifier): void {
    if (handedToCall(writerValue(reference, this.#owner.names)) && !this.#inHandler(reference)) {
      this.#fail(
        `\`${reference.text}\` writes a state, and given to a call as the JSX is built — \`items.map(${reference.text})\` — it may be called then, and write again on every render a write brings: it is called, or handed on, ${HANDLER_ONLY}`,
        reference,
      );
    }
  }

  /** What a call of a setter writes: a registered update, or the state's `set`. */
  #updateOf(call: CallExpression, setter: Setter): UpdaterSite {
    const [input, ...more] = call.arguments;
    if (input === undefined || more.length > 0 || isSpreadElement(input)) {
      return this.#fail('The setter takes one argument: an update, or a value.', call);
    }
    let argument = input;
    while (isParenthesizedExpression(argument)) {
      argument = argument.expression;
    }
    let fn: ArrowFunction | FunctionExpression | undefined;
    if (isArrowFunction(argument) || isFunctionExpression(argument)) {
      fn = argument;
    } else if (isIdentifier(argument)) {
      fn = this.#constants.get(argument.text);
    }
    if (fn === undefined) {
      return { id: setter.set, kind: 'set' };
    }
    const update = readUpdate(fn, this.#owner);
    return {
      id: updaterId(this.#owner.id, setter.site, update.form),
      kind: 'apply',
      type: setter.type,
      update,
    };
  }

  #register(site: UpdaterSite, key: string): void {
    if (site.id === UNREGISTERED) {
      return;
    }
    const entry = this.#updaters.get(site.id);
    if (entry === undefined) {
      this.#updaters.set(site.id, { keys: new Set([key]), site });
    } else {
      entry.keys.add(key);
      if (entry.site.kind === 'set' && site.kind === 'apply') {
        entry.site = site;
      }
    }
  }

  /**
   * What calling `value` writes: every setter and hook's function reachable through its aliases,
   * container entries and functions. The worklist closes each graph before caching it, including
   * functions and aliases that reach each other, so no in-progress answer can hide a write.
   */
  #usesOf(value: Expression): Uses {
    const known = this.#uses.get(value);
    if (known !== undefined) {
      return known;
    }
    const uses = new Map<string, Set<string>>();
    const pending = [value];
    const seen = new Set<Expression>();
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const held of heldWriters(current, this.#owner.names)) {
        if (isArrowFunction(held) || isFunctionExpression(held)) {
          for (const [, reference] of this.#readsIn(held)) {
            pending.push(writerValue(reference, this.#owner.names));
          }
          continue;
        }
        addUses(uses, this.#writesOf(held.text, held));
      }
    }
    const result: Uses = new Map([...uses].map(([id, keys]) => [id, [...keys]]));
    this.#uses.set(value, result);
    return result;
  }

  /** Each read of a top-level name within `fn`, at any depth, with the name. */
  *#readsIn(fn: ArrowFunction | FunctionExpression): Generator<readonly [string, Identifier]> {
    for (const [name, references] of this.#owner.reads) {
      for (const reference of references) {
        if (within(reference, fn)) {
          yield [name, reference];
        }
      }
    }
  }

  /** What a read of `name` within a function makes the function write itself: a constant's aside. */
  #writesOf(name: string, reference: Identifier): Uses {
    const setter = this.#owner.setters.get(name);
    if (setter?.local === true) {
      return new Map([[UNREGISTERED, [setter.key]]]);
    }
    if (setter !== undefined) {
      const { parent } = reference;
      const site =
        isCallExpression(parent) && parent.expression === reference
          ? this.#updateOf(parent, setter)
          : { id: setter.set, kind: 'set' as const };
      return new Map([[site.id, [setter.key]]]);
    }
    return this.#owner.writing.get(name) ?? new Map();
  }

  /**
   * Whether `node` runs from the handler of an event a person's action dispatches — within a
   * function given as such an attribute's value, at any depth, or within a constant function of the
   * owner's, or a function a hook returns, whose own reads are held to this — rather than while the
   * tree is built, as a call in a child, or in a function a child's expression calls at once
   * (`items.map(…)`), would, as React commits it, as a callback `ref` is, or as an event that fires
   * by itself does.
   */
  #inHandler(node: Node): boolean {
    for (let parent = node.parent; parent !== this.#owner.declaration; parent = parent.parent) {
      if (
        (isArrowFunction(parent) || isFunctionExpression(parent)) &&
        (handlerAttributeOf(parent) !== undefined ||
          this.#isConstant(parent) ||
          this.#isItem(parent))
      ) {
        return true;
      }
    }
    return false;
  }

  /** Whether a function is what a top-level constant of the owner's holds. */
  #isConstant(fn: ArrowFunction | FunctionExpression): boolean {
    return [...this.#constants.values()].includes(fn);
  }

  /** Whether `node` is an item of what a hook returns: its callers' to read. */
  #isItem(node: Node): boolean {
    return [...this.#owner.items.values()].includes(node);
  }
  read(): Writes {
    for (const [name, references] of this.#owner.reads) {
      for (const reference of references) {
        this.#reference(name, reference);
      }
    }
    return {
      calls: this.#calls,
      constants: this.#constants,
      updaters: this.#updaters,
      usesOf: (fn) => this.#usesOf(fn),
    };
  }
}

/** Reads what an owner's code writes, refusing a write made anywhere but a person's action. */
export function collectWrites(owner: Owner): Writes {
  return new WriteReader(owner).read();
}

function add(uses: Map<string, Set<string>>, id: string, key: string): void {
  const keys = uses.get(id);
  if (keys === undefined) {
    uses.set(id, new Set([key]));
  } else {
    keys.add(key);
  }
}

/** All keys each update of `written` writes. */
function addUses(uses: Map<string, Set<string>>, written: Uses): void {
  for (const [id, keys] of written) {
    for (const key of keys) {
      add(uses, id, key);
    }
  }
}

function within(node: Node, outer: Node): boolean {
  return node.pos >= outer.pos && node.end <= outer.end;
}

/** The members a function is called through: `write.call(…)`, `write.apply(…)`. */
const CALLING: ReadonlySet<string> = new Set(['apply', 'call']);

/**
 * The call that calls what `reference` names — a call of it, `write(…)`, of its `.call` or
 * `.apply` (including an unknown computed member), and a template it tags — within parentheses
 * and casts, and through conditional or logical selections; none where it is not called.
 */
function callOf(
  reference: Expression,
  names: ReadonlyMap<string, TopLevel>,
): CallExpression | TaggedTemplateExpression | undefined {
  let node: Node = reference;
  while (selectsWriter(node)) {
    node = node.parent;
  }
  const member = node.parent;
  const key = isElementAccessExpression(member)
    ? writtenKey(member.argumentExpression, names)
    : undefined;
  if (
    ((isPropertyAccessExpression(member) && CALLING.has(member.name.text)) ||
      (isElementAccessExpression(member) && (key === undefined || CALLING.has(key)))) &&
    member.expression === node
  ) {
    node = member;
  }
  const { parent } = node;
  if (isCallExpression(parent) && parent.expression === node) {
    return parent;
  }
  return isTaggedTemplateExpression(parent) && parent.tag === node ? parent : undefined;
}

/** A writer is truthy, so logical and cannot return it from its left operand. */
function selectsWriter(node: Node): boolean {
  const { parent } = node;
  return (
    standsAsItIs(node) &&
    !(
      isBinaryExpression(parent) &&
      parent.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken &&
      parent.left === node
    )
  );
}

/** The operators that answer one of their operands: `??`, `||`, `&&`. */
const EITHER: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Whether what `reference` names is handed to a call, a `new` or a tag, as it is — through
 * parentheses and casts, either answer of a condition, an operand of `&&`, `||`, `??` — an argument
 * of it, what a spread there hands, a substitution of a tag's.
 */
function handedToCall(reference: Expression): boolean {
  let node: Node = reference;
  while (standsAsItIs(node)) {
    node = node.parent;
  }
  const at = isSpreadElement(node.parent) ? node.parent : node;
  const { parent } = at;
  if (isCallExpression(parent) || isNewExpression(parent)) {
    return parent.arguments?.some((each) => each === at) === true;
  }
  return isTemplateSpan(parent) && isTaggedTemplateExpression(parent.parent.parent);
}

/** Whether the parent of `node` answers it as it is, or may: parentheses, a cast, a condition, `&&`, `||`, `??`. */
function standsAsItIs(node: Node): boolean {
  const { parent } = node;
  if (
    (isParenthesizedExpression(parent) ||
      isAsExpression(parent) ||
      isSatisfiesExpression(parent) ||
      isNonNullExpression(parent)) &&
    parent.expression === node
  ) {
    return true;
  }
  if (isConditionalExpression(parent)) {
    return parent.whenTrue === node || parent.whenFalse === node;
  }
  return isBinaryExpression(parent) && EITHER.has(parent.operatorToken.kind);
}

/** The owner's constants that hold a function written there: `const increase = () => …`. */
function constantFunctions(
  names: ReadonlyMap<string, TopLevel>,
): ReadonlyMap<string, ArrowFunction | FunctionExpression> {
  const found = new Map<string, ArrowFunction | FunctionExpression>();
  for (const [name, entry] of names) {
    if (entry.kind === 'constant' && isIdentifier(entry.declaration.name)) {
      const fn = functionOf(entry.declaration);
      if (fn !== undefined) {
        found.set(name, fn);
      }
    }
  }
  return found;
}
