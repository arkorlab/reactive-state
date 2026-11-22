import {
  type BindingName,
  type Identifier,
  isBindingElement,
  isClassDeclaration,
  isClassExpression,
  isComputedPropertyName,
  isEnumDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectBindingPattern,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
  type ObjectBindingPattern,
  type SourceFile,
  type Statement,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import type { ImportBinding } from './imports.ts';
import { prefixDeclarations } from './prefix.ts';
import { untrackedIn } from './reach.ts';
import { bindingIdentifiers, declaredWithin, isTypeOnly, type Names, walk } from './scope.ts';

/**
 * What each statement of a route middleware reads of its names — its imports, its context's
 * `params` and `request`, `next`, and what its body declares at its top level — which tells the
 * guard the authority runs from the envelope the host runs, and what each of them imports. Names are
 * resolved lexically, as a component's are (`scope.ts`), and so a name the body declares at its top
 * level is declared once in it: the split tells each name's side by the name.
 */

/** Which of the context's props a name the context is destructured into holds. */
type ContextProperty = 'params' | 'request';

/** The middleware's first parameter: the context whole, or destructured by its props. */
export type ContextParameter =
  | { readonly kind: 'whole'; readonly name: Identifier }
  | {
      readonly kind: 'pattern';
      readonly pattern: ObjectBindingPattern;
      /** Each name it declares, with the prop of the context it holds (part of). */
      readonly properties: ReadonlyMap<string, ContextProperty>;
    };

/** What a middleware's statements are read with. */
export interface MiddlewareNames {
  readonly sourceFile: SourceFile;
  readonly fail: Fail;
  /** Each import, by the name it declares. */
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly context: ContextParameter | undefined;
  readonly next: Identifier;
  /** What a walk of a statement is given: the middleware's names (`scope.ts`). */
  readonly names: Names;
  /** Every name the file declares: a read of none of them is a global. */
  readonly declared: ReadonlySet<string>;
}

/** What one statement reads. */
export interface StatementReads {
  /** Each of the middleware's names it reads at run time, at each place it reads it. */
  readonly values: ReadonlyMap<string, readonly Identifier[]>;
  /** Each of them a type of it names. */
  readonly types: ReadonlySet<string>;
  /** A global it reads that nothing tracks — `crypto`, `Date.now` — the first. */
  readonly untracked: string | undefined;
}

const PROPERTIES: ReadonlySet<string> = new Set<ContextProperty>(['params', 'request']);

const CONTEXT_REST =
  "A route middleware's context is destructured by name at every depth: the compile writes the pattern into each part it splits the middleware into with the names that part reads alone, where a rest (`...rest`) would hold what the part leaves out.";

/**
 * Refuses a rest in an object the context's pattern destructures, however deep: each part's copy of
 * the pattern holds the names the part reads alone (`patternOf`, `emit-middleware.ts`), and a rest
 * would hold there what the others take. An array's pattern is copied whole, a rest in it as well.
 */
function checkRest(pattern: ObjectBindingPattern, fail: Fail): void {
  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) {
      fail(CONTEXT_REST, element);
    }
    if (element.name !== undefined && isObjectBindingPattern(element.name)) {
      checkRest(element.name, fail);
    }
  }
}

/** The context's names, by the prop of it each holds: `({ params, request: r })`, nested in `params`. */
export function contextOf(name: BindingName, fail: Fail): ContextParameter {
  if (isIdentifier(name)) {
    return { kind: 'whole', name };
  }
  if (!isObjectBindingPattern(name)) {
    return fail(
      "A route middleware's context is an object: name it, or destructure its `params` and `request` by name.",
      name,
    );
  }
  const properties = new Map<string, ContextProperty>();
  for (const element of name.elements) {
    const key = element.propertyName ?? element.name;
    const property = key !== undefined && isIdentifier(key) ? key.text : '';
    const bound = element.name;
    if (bound === undefined || element.dotDotDotToken !== undefined || !PROPERTIES.has(property)) {
      return fail(
        "A route middleware's context is destructured by its props, `params` and `request`, each by name: what else it holds is the framework's.",
        element,
      );
    }
    if (isObjectBindingPattern(bound)) {
      checkRest(bound, fail);
    }
    const identifiers = bindingIdentifiers(bound);
    for (const identifier of identifiers) {
      properties.set(identifier.text, property as ContextProperty);
    }
  }
  return { kind: 'pattern', pattern: name, properties };
}

/** The identifiers the context's parameter declares. */
function contextIdentifiers(context: ContextParameter | undefined): readonly Identifier[] {
  if (context === undefined) {
    return [];
  }
  return context.kind === 'whole'
    ? [context.name]
    : context.pattern.elements.flatMap((element) =>
        element.name === undefined ? [] : bindingIdentifiers(element.name),
      );
}

/** Whether `node` is the name a declaration gives — a variable's, a parameter's, a function's. */
function declaresName(node: Identifier): boolean {
  const parent = node.parent;
  return (
    (isVariableDeclaration(parent) ||
      isParameterDeclaration(parent) ||
      isBindingElement(parent) ||
      isFunctionDeclaration(parent) ||
      isFunctionExpression(parent) ||
      isClassDeclaration(parent) ||
      isClassExpression(parent) ||
      isEnumDeclaration(parent)) &&
    parent.name === node
  );
}

/**
 * Refuses a declaration nested in the body that takes one of the middleware's top-level names —
 * which a walk would read as that name — in the middleware's own words. What is erased with the
 * types declares nothing (`isTypeOnly`): a parameter of a function's type, of an interface's
 * signature, of an overload.
 */
function checkNested(statements: readonly Statement[], names: Names, fail: Fail): void {
  const visit = (node: Node): void => {
    if (isTypeOnly(node)) {
      return;
    }
    if (
      isIdentifier(node) &&
      declaresName(node) &&
      names.topLevel.has(node.text) &&
      !names.declaring.has(node)
    ) {
      fail(
        `\`${node.text}\` is one of the route middleware's own names — an import, its context's, \`next\`, or what its body declares — declared again inside it: give it a name of its own. The compile tells what the guard reads from what the envelope reads by the name.`,
        node,
      );
    }
    node.forEachChild(visit);
  };
  for (const statement of statements) {
    visit(statement);
  }
}

export interface NamesInput {
  readonly sourceFile: SourceFile;
  readonly fail: Fail;
  readonly bindings: readonly ImportBinding[];
  readonly context: ContextParameter | undefined;
  readonly next: Identifier;
  readonly statements: readonly Statement[];
}

/** The middleware's names, its body's statements checked for a declaration that takes one. */
export function middlewareNames(input: NamesInput): MiddlewareNames {
  const { bindings, context, fail, next, sourceFile, statements } = input;
  const declaring = [
    ...bindings.map((binding) => binding.name),
    ...contextIdentifiers(context),
    next,
    // An overload's signature, erased, declares nothing: its implementation declares the name.
    ...prefixDeclarations(statements).filter(
      ({ parent }) => !(isFunctionDeclaration(parent) && parent.body === undefined),
    ),
  ];
  const topLevel = new Set<string>();
  for (const identifier of declaring) {
    if (topLevel.has(identifier.text)) {
      fail(
        `\`${identifier.text}\` is declared twice among the route middleware's own names — its imports, its context's, \`next\`, and what its body declares: give each a name of its own.`,
        identifier,
      );
    }
    topLevel.add(identifier.text);
  }
  const declared = new Set([...declaredWithin(sourceFile), ...topLevel]);
  const names: Names = { declared, declaring: new Set<Node>(declaring), topLevel };
  checkNested(statements, names, fail);
  return {
    context,
    declared,
    fail,
    imports: new Map(bindings.map((binding) => [binding.name.text, binding])),
    names,
    next,
    sourceFile,
  };
}

/** What `node` — a statement, or an expression in one — reads of the middleware's names. */
export function readsOf(node: Node, middleware: MiddlewareNames): StatementReads {
  const values = new Map<string, Identifier[]>();
  const types = new Set<string>();
  walk(
    node,
    middleware.names,
    {
      read: (identifier, space) => {
        if (space === 'type') {
          types.add(identifier.text);
          return;
        }
        const places = values.get(identifier.text);
        if (places === undefined) {
          values.set(identifier.text, [identifier]);
        } else {
          places.push(identifier);
        }
      },
    },
    middleware.fail,
  );
  return { types, untracked: untrackedIn([node]), values };
}

/** The names a statement declares at the body's top level. */
export function declaredBy(statement: Statement): readonly string[] {
  return prefixDeclarations([statement]).map((identifier) => identifier.text);
}

/** Whether `reads` reads any of `names` at run time. */
export function readsAnyOf(reads: StatementReads, names: Iterable<string>): string | undefined {
  for (const name of names) {
    if (reads.values.has(name)) {
      return name;
    }
  }
  return undefined;
}

/** The first place `reads` reads `name` at run time. */
export function placeOf(reads: StatementReads, name: string): Identifier | undefined {
  return reads.values.get(name)?.[0];
}

/**
 * The context's names a read reaches the request by: `request`, as destructured, or the context
 * whole read anywhere but its `params` (`context.params`).
 */
export function requestRead(
  reads: StatementReads,
  context: ContextParameter | undefined,
): Identifier | undefined {
  if (context === undefined) {
    return undefined;
  }
  if (context.kind === 'whole') {
    return reads.values.get(context.name.text)?.find((identifier) => {
      const { parent } = identifier;
      return !(
        isPropertyAccessExpression(parent) &&
        parent.expression === identifier &&
        parent.name.text === 'params'
      );
    });
  }
  for (const [name, property] of context.properties) {
    const place = property === 'request' ? placeOf(reads, name) : undefined;
    if (place !== undefined) {
      return place;
    }
  }
  return undefined;
}

/** What the context's pattern runs where a part binds names of it (`patternReads`). */
export interface PatternReads {
  /** The context's names the part binds: those it reads, and each a default of theirs reads. */
  readonly context: ReadonlySet<string>;
  /** What each default and each computed key the part's copy of the pattern holds reads. */
  readonly reads: ReadonlyMap<Node, StatementReads>;
}

/**
 * The defaults and computed keys of `pattern` that run where a part binds `bound` of its names: those
 * of each element that binds any of them, and of each object pattern that holds one — an element
 * other than an object's pattern whole, as a part's copy of the pattern keeps it.
 */
function evaluatedIn(pattern: ObjectBindingPattern, bound: ReadonlySet<string>): readonly Node[] {
  return pattern.elements.flatMap((element) => {
    const { initializer, name, propertyName: key } = element;
    if (name === undefined || bindingIdentifiers(name).every((each) => !bound.has(each.text))) {
      return [];
    }
    const own = [
      ...(key !== undefined && isComputedPropertyName(key) ? [key.expression] : []),
      ...(initializer === undefined ? [] : [initializer]),
    ];
    if (isObjectBindingPattern(name)) {
      return [...own, ...evaluatedIn(name, bound)];
    }
    return isIdentifier(name) ? own : [...own, name];
  });
}

/**
 * What the context's pattern runs where a part binds `bound` of its names: each default and each
 * computed key that runs there (`evaluatedIn`), what they read, and each name of the context they
 * read bound too, in turn, until none is new — `{ params: { projectId, tenant = projectId + '-t' } }`
 * binds `projectId` wherever it binds `tenant`.
 */
export function patternReads(bound: Iterable<string>, middleware: MiddlewareNames): PatternReads {
  const { context } = middleware;
  const names = new Set(bound);
  const reads = new Map<Node, StatementReads>();
  if (context?.kind !== 'pattern') {
    return { context: names, reads };
  }
  let grown = true;
  while (grown) {
    grown = false;
    for (const node of evaluatedIn(context.pattern, names)) {
      if (reads.has(node)) {
        continue;
      }
      const read = readsOf(node, middleware);
      reads.set(node, read);
      for (const name of contextReads(read.values.keys(), context)) {
        grown ||= !names.has(name);
        names.add(name);
      }
    }
  }
  return { context: names, reads };
}

/** The context's names among `read`, names a part reads at run time. */
export function contextReads(
  read: Iterable<string>,
  context: ContextParameter | undefined,
): readonly string[] {
  if (context === undefined) {
    return [];
  }
  const own = new Set(context.kind === 'whole' ? [context.name.text] : context.properties.keys());
  return [...read].filter((name) => own.has(name));
}

/** Every name of `parts`, each once: what two parts of a middleware read, together. */
export function unionOf(...parts: readonly (Iterable<string> | undefined)[]): Set<string> {
  const union = new Set<string>();
  for (const part of parts) {
    if (part !== undefined) {
      for (const name of part) {
        union.add(name);
      }
    }
  }
  return union;
}
