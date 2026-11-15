import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isClassDeclaration,
  isConditionalExpression,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxSpreadAttribute,
  isNamespaceImport,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableStatement,
  type JsxAttributeLike,
  type JsxElement,
  type JsxSelfClosingElement,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { isLiteral, unwrapped } from './page-shape.ts';
import { bindingIdentifiers, isTypeOnly, readsBinding } from './scope.ts';
import { byCodeUnits } from './splice.ts';
import { isConstant } from './statements.ts';

/**
 * What the values a page hands its root are, read off the page's syntax: a param of the route as
 * it is — what `await params` destructured — a value of the search params, or of what is computed
 * of them alone, a constant; or anything else, which no route of the root can be registered of
 * (`page-render.ts`).
 */

/** One of the page's props: its route's params, its search params, or its props whole. */
export type Source = 'params' | 'props' | 'searchParams';

/** What a name of a function of the page holds, as a prop of the root reads it. */
export type Held =
  | { readonly kind: 'constant' }
  /** Computed of something other than the search params alone: a param, a module's answer. */
  | { readonly kind: 'other' }
  | { readonly kind: 'param'; readonly param: string }
  | { readonly kind: 'search' }
  | {
      readonly kind: 'source';
      readonly source: Source;
      /**
       * Of props whole (`props`): which of the page's props each of its own is, by name, as the
       * page handed them — `params` its `searchParams`, where `<Inner params={searchParams} />`
       * handed it so; the page's own (`{ params: 'params', searchParams: 'searchParams' }`).
       */
      readonly handed?: ReadonlyMap<string, Source>;
    };

const CONSTANT: Held = { kind: 'constant' };
export const OTHER: Held = { kind: 'other' };
export const SEARCH: Held = { kind: 'search' };

/** What a page's function reads its names in: its own, the file's, and those declared within it. */
export interface Scope {
  readonly locals: Map<string, Held>;
  /** The file's top-level names: a constant of a literal's, or any other. */
  readonly module: ReadonlyMap<string, 'constant' | 'module'>;
  /** Every name the function declares, at any depth: one it does not hold at its top level is none to read. */
  readonly declared: ReadonlySet<string>;
}

/** The names an import declares. */
function importedLocals(statement: Statement): readonly Identifier[] {
  const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
  const named = clause?.namedBindings;
  const locals: Identifier[] = clause?.name === undefined ? [] : [clause.name];
  if (named !== undefined && isNamespaceImport(named)) {
    locals.push(named.name);
  } else if (named !== undefined) {
    locals.push(...named.elements.map((element) => element.name));
  }
  return locals;
}

/** The names a top-level variable statement declares, each a constant of a literal's or not. */
function variableNames(statement: Statement, sourceFile: SourceFile): readonly [string, boolean][] {
  if (!isVariableStatement(statement)) {
    return [];
  }
  const constant = isConstant(statement, sourceFile);
  const names: [string, boolean][] = [];
  for (const { initializer, name } of statement.declarationList.declarations) {
    const literal =
      constant && isIdentifier(name) && initializer !== undefined && isLiteral(initializer);
    for (const identifier of bindingIdentifiers(name)) {
      names.push([identifier.text, literal]);
    }
  }
  return names;
}

/** The name a top-level function, class or enum declares. */
function declarationName(statement: Statement): string | undefined {
  const declared =
    isFunctionDeclaration(statement) ||
    isClassDeclaration(statement) ||
    isEnumDeclaration(statement);
  return declared ? statement.name?.text : undefined;
}

/** The file's top-level names: each constant of a literal, and each other name it declares or imports. */
export function moduleNamesOf(sourceFile: SourceFile): ReadonlyMap<string, 'constant' | 'module'> {
  const names = new Map<string, 'constant' | 'module'>();
  for (const statement of sourceFile.statements) {
    for (const local of importedLocals(statement)) {
      names.set(local.text, 'module');
    }
    for (const [name, literal] of variableNames(statement, sourceFile)) {
      names.set(name, literal ? 'constant' : 'module');
    }
    const declared = declarationName(statement);
    if (declared !== undefined) {
      names.set(declared, 'module');
    }
  }
  return names;
}

/** Each name `node` reads at run time, outside its types. */
export function namesRead(node: Node): readonly Identifier[] {
  const read: Identifier[] = [];
  const pending = [node];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    if (isTypeOnly(each)) {
      continue;
    }
    if (isIdentifier(each) && readsBinding(each)) {
      read.push(each);
    }
    each.forEachChild((child) => {
      pending.push(child);
    });
  }
  return read;
}

/** What a name `identifier` reads holds: the search params', something else; none for the file's and the language's. */
function readOf(identifier: Identifier, scope: Scope): 'other' | 'search' | undefined {
  const held = scope.locals.get(identifier.text);
  if (held === undefined) {
    // A name of the file's, or of the language's — but one declared within the function and not
    // held at its top level, a parameter of a function within, is none of what the page hands on.
    const nested = scope.declared.has(identifier.text) && !scope.module.has(identifier.text);
    return nested ? 'other' : undefined;
  }
  if (held.kind === 'search' || (held.kind === 'source' && held.source === 'searchParams')) {
    return 'search';
  }
  return held.kind === 'constant' ? undefined : 'other';
}

/** What an expression computes of: the search params, with what the file and the language give, alone. */
function derivedOf(expression: Node, scope: Scope): Held {
  const reads = new Set(namesRead(expression).map((identifier) => readOf(identifier, scope)));
  return reads.has('search') && !reads.has('other') ? SEARCH : OTHER;
}

/** What a value is: a param as it is, of the search params, a constant, or anything else. */
export function valueOf(expression: Expression, scope: Scope): Held {
  const value = unwrapped(expression);
  if (isIdentifier(value)) {
    const held = scope.locals.get(value.text);
    if (held !== undefined) {
      return held.kind === 'source' ? OTHER : held;
    }
    const literal = scope.module.get(value.text) === 'constant' || value.text === 'undefined';
    return literal ? CONSTANT : OTHER;
  }
  return isLiteral(value) ? CONSTANT : derivedOf(value, scope);
}

/** One element of the root's props: those the page gives a param of as it is, and the rest. */
export interface ElementProps {
  readonly params: ReadonlyMap<string, string>;
  readonly given: ReadonlySet<string>;
}

/** The objects a conditional spread of props is one of: `cond ? { a } : {}`, `cond && { a }`. */
function spreadObjects(expression: Expression): readonly Expression[] {
  const objects: Expression[] = [];
  const pending = [expression];
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const value = unwrapped(each);
    if (isConditionalExpression(value)) {
      pending.push(value.whenTrue, value.whenFalse);
    } else if (
      isBinaryExpression(value) &&
      value.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken
    ) {
      pending.push(value.right);
    } else {
      objects.push(value);
    }
  }
  return objects;
}

/** Each prop a conditional spread of object literals gives, with its value; none where it is no such spread. */
function spreadProps(expression: Expression): readonly [string, Expression][] | undefined {
  const props: [string, Expression][] = [];
  for (const object of spreadObjects(expression)) {
    if (!isObjectLiteralExpression(object)) {
      return undefined;
    }
    for (const property of object.properties) {
      const shorthand = isShorthandPropertyAssignment(property);
      if (!shorthand && !isPropertyAssignment(property)) {
        return undefined;
      }
      const { name } = property;
      if (!isIdentifier(name)) {
        return undefined;
      }
      props.push([name.text, shorthand ? name : property.initializer]);
    }
  }
  return props;
}

/** An attribute's prop and value, conditional where its spread may leave the prop absent. */
type Given = readonly [string, Expression | undefined, boolean];

/** What an attribute of the root's element gives: its props; none where it is of another form. */
function attributeProps(attribute: JsxAttributeLike): readonly Given[] | undefined {
  if (isJsxSpreadAttribute(attribute)) {
    const conditional = !isObjectLiteralExpression(unwrapped(attribute.expression));
    const props = spreadProps(attribute.expression);
    return props?.map(([name, value]): Given => [name, value, conditional]);
  }
  if (!isJsxAttribute(attribute) || !isIdentifier(attribute.name)) {
    return undefined;
  }
  const { initializer, name } = attribute;
  if (initializer === undefined || isStringLiteral(initializer)) {
    return [[name.text, undefined, false]];
  }
  const value = isJsxExpression(initializer) ? initializer.expression : undefined;
  return value === undefined ? undefined : [[name.text, value, false]];
}

/** Records the props `given` into `props`, as their values are; whether each is of what a page hands on. */
function record(
  given: readonly Given[],
  props: { params: Map<string, string>; given: Set<string> },
  scope: Scope,
): boolean {
  for (const [name, value, conditional] of given) {
    const held = value === undefined ? CONSTANT : valueOf(value, scope);
    if (held.kind === 'other') {
      return false;
    }
    if (name === 'key') continue;
    if (!conditional && held.kind === 'param') {
      props.params.set(name, held.param);
      props.given.delete(name);
    } else {
      props.params.delete(name);
      props.given.add(name);
    }
  }
  return true;
}

/** The props one element of the root is given, as their values are; none where one is of anything else. */
export function elementProps(
  element: JsxElement | JsxSelfClosingElement,
  scope: Scope,
): ElementProps | undefined {
  const props = { given: new Set<string>(), params: new Map<string, string>() };
  const attributes = isJsxElement(element) ? element.openingElement.attributes : element.attributes;
  for (const attribute of attributes.properties) {
    const given = attributeProps(attribute);
    if (given === undefined || !record(given, props, scope)) {
      return undefined;
    }
  }
  return props;
}

/** The props every element gives a param as it is, by the prop; the rest given, sorted. */
export function propsOfAll(each: readonly ElementProps[]): {
  readonly props: Readonly<Record<string, string>>;
  readonly given: readonly string[];
} {
  const [first, ...rest] = each;
  const mapped = new Map<string, string>();
  const params = first?.params ?? new Map<string, string>();
  for (const [name, param] of params) {
    if (rest.every((other) => other.params.get(name) === param)) {
      mapped.set(name, param);
    }
  }
  const given = new Set<string>();
  const add = (name: string): void => {
    if (!mapped.has(name)) {
      given.add(name);
    }
  };
  for (const element of each) {
    for (const name of element.params.keys()) {
      add(name);
    }
    for (const name of element.given) {
      add(name);
    }
  }
  return { given: [...given].toSorted(byCodeUnits), props: Object.fromEntries(mapped) };
}
