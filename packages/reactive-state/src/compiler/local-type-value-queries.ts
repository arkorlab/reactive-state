import {
  factory,
  type EntityName,
  type Expression,
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isQualifiedName,
  isTypeQueryNode,
  isVariableDeclaration,
  isVariableStatement,
  type Identifier,
  type Node,
  type TypeQueryNode,
  type TypeNode,
} from 'typescript/ast';

import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { callableQueryReading } from './local-type-callable-queries.ts';
import { localClassPrototypeReading } from './local-type-class-prototypes.ts';
import { type TypeReading, typeReadingKey } from './local-type-environment.ts';
import { prototypeQueryBuiltin } from './local-type-prototype-queries.ts';
import { queryArgumentReadings } from './local-type-query-arguments.ts';
import { memberReadings, QUERY_KEY_PREFIX } from './local-type-selections.ts';

/** Local value queries retain explicit types and directly written native Error constructions. */

const ERRORS = new Set([
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
const PROTOTYPES = new WeakMap<Node, TypeQueryNode>();

/** Annotation syntax wins; only a direct native initializer supplies an otherwise unwritten instance. */
export function valueQueryReading(
  at: TypeReading,
  operands: (reading: TypeReading) => readonly TypeReading[],
): readonly TypeReading[] | undefined {
  const { type } = at;
  if (!isTypeQueryNode(type)) return undefined;
  const query = queriedMember(type.exprName);
  const binding = queryBinding(query.root);
  if (binding === undefined) return undefined;
  const selection = { ...binding, keys: [...binding.keys, ...query.keys] };
  const key = entryKey(at, selection);
  if (key === undefined) return undefined;
  const reading = { ...at, aliases: new Set([...at.aliases, key]) };
  if (selection.type !== undefined)
    return queryArgumentReadings(
      reading,
      memberReadings({ ...reading, type: selection.type }, selection.keys, operands),
      operands,
    );
  if (selection.keys.length > 0) {
    const prototype = localClassPrototypeReading(reading);
    return prototype === undefined ? undefined : [prototype];
  }
  const declared = callableQueryReading(reading);
  if (declared !== undefined) return queryArgumentReadings(reading, [declared], operands);
  const initializer = queriedInitializer(query.root);
  if (initializer === undefined) return undefined;
  const instance = nativeInstanceQuery(initializer);
  return instance === undefined ? undefined : [{ ...reading, type: instance }];
}

/** A value query keeps the original lexical root and each written member in selection order. */
function queriedMember(name: EntityName): {
  readonly root: Identifier;
  readonly keys: readonly string[];
} {
  const keys: string[] = [];
  let root = name;
  while (isQualifiedName(root)) {
    keys.unshift(root.right.text);
    root = root.left;
  }
  return { keys, root };
}

/** Selected binding paths retain each written annotation before a whole initializer is considered. */
function queryBinding(
  name: Identifier,
): { readonly type: TypeNode | undefined; readonly keys: readonly string[] } | undefined {
  let reference = name;
  let keys: readonly string[] = [];
  const seen = new Set<Node>();
  while (!seen.has(reference)) {
    seen.add(reference);
    const selected = frameBindingOf(reference);
    if (selected === undefined) return { type: undefined, keys };
    const { binding } = selected;
    keys = [...selected.keys, ...keys];
    if (binding.type !== undefined) return { type: binding.type, keys };
    const value =
      binding.initializer === undefined ? undefined : parenthesizedValue(binding.initializer);
    if (value === undefined || !isIdentifier(value)) return { type: undefined, keys };
    reference = value;
  }
  return undefined;
}

/**
 * How many entries of a query already on a reading's path one path may make in all. A selection made
 * of a reading the query gave starts from the queries that path holds, so a finite path of indexes
 * may enter the same query again, `(typeof v)["self"]["self"]["e"]` of an interface that holds
 * `self: typeof v`; a query that gives itself is entered each time it is read, and the bound ends
 * it, as a repeat of an alias does. Past it the query reads as none, as a path of aliases past
 * `ALIAS_PATH` does. The first entry of each query is no repeat, so a path of different queries is
 * as long as the code writes it.
 */
const QUERY_REPEATS = 4;

/**
 * The key of the next entry of a query on a reading's path, none where it is a repeat past
 * `QUERY_REPEATS`. A query is what it reads: the written type of the name it queries, the members
 * it selects and the actual arguments it holds, by what they hold rather than by the map that
 * holds them, which a selection through an interface makes anew. Queries of one name and members
 * written in several places are one, as they read one type; a query given type arguments, which
 * its reading applies, stays its own syntax.
 */
function entryKey(
  at: TypeReading,
  selection: { readonly type: TypeNode | undefined; readonly keys: readonly string[] },
): string | undefined {
  const { type } = at;
  const read =
    selection.type !== undefined && isTypeQueryNode(type) && type.typeArguments === undefined
      ? { ...at, type: selection.type }
      : at;
  const query = `${QUERY_KEY_PREFIX}${typeReadingKey(read)}${JSON.stringify(selection.keys)}#`;
  let entered = 0;
  while (at.aliases.has(`${query}${entered}`)) entered += 1;
  if (entered > 0) {
    const repeats = [...at.aliases].filter(
      (key) => key.startsWith(QUERY_KEY_PREFIX) && !key.endsWith('#0'),
    );
    if (repeats.length >= QUERY_REPEATS) return undefined;
  }
  return `${query}${entered}`;
}

/** Whole value aliases preserve the original initializer; assertions and arbitrary calls stay opaque. */
function queriedInitializer(name: Identifier): Expression | undefined {
  let value: Expression = name;
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = frameDeclarationOf(value);
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isIdentifier(declared.name) ||
      declared.type !== undefined ||
      declared.initializer === undefined
    )
      return undefined;
    value = parenthesizedValue(declared.initializer);
  }
  return isNewExpression(value) || isCallExpression(value) ? value : undefined;
}

/** A stable query container retains original constructor roots rather than inventing a type reference. */
function nativeInstanceQuery(initializer: Expression): TypeQueryNode | undefined {
  if (!isNewExpression(initializer) && !isCallExpression(initializer)) return undefined;
  const previous = PROTOTYPES.get(initializer);
  if (previous !== undefined) return previous;
  const constructor = nativeConstructor(initializer.expression);
  if (constructor === undefined) return undefined;
  const entity = constructorEntity(constructor);
  if (entity === undefined) return undefined;
  const query = factory.createTypeQueryNode(
    factory.createQualifiedName(entity, factory.createIdentifier('prototype')),
  );
  if (prototypeQueryBuiltin(query) === undefined) return undefined;
  PROTOTYPES.set(initializer, query);
  return query;
}

/** Immutable native constructor aliases resolve in their written lexical value scopes. */
function nativeConstructor(expression: Expression): Expression | undefined {
  let value = parenthesizedValue(expression);
  const seen = new Set<Node>();
  while (!seen.has(value)) {
    seen.add(value);
    if (ERRORS.has(globalPathOf(value)?.join('.') ?? '')) return value;
    if (!isIdentifier(value)) return undefined;
    const declared = frameDeclarationOf(value);
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isIdentifier(declared.name) ||
      declared.initializer === undefined
    )
      return undefined;
    const statement = declared.parent.parent;
    if (
      !isVariableStatement(statement) ||
      !/^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    )
      return undefined;
    value = parenthesizedValue(declared.initializer);
  }
  return undefined;
}

/** Qualified native constructors keep the original lexical identifier at their entity root. */
function constructorEntity(expression: Expression): EntityName | undefined {
  const names: Identifier[] = [];
  let value = expression;
  while (isPropertyAccessExpression(value)) {
    if (!isIdentifier(value.name)) return undefined;
    names.unshift(value.name);
    value = value.expression;
  }
  if (!isIdentifier(value)) return undefined;
  let entity: EntityName = value;
  for (const name of names) entity = factory.createQualifiedName(entity, name);
  return entity;
}

/** Parentheses alone preserve a direct initializer; erased assertions retain their own boundary. */
function parenthesizedValue(expression: Expression): Expression {
  let value = expression;
  while (isParenthesizedExpression(value)) value = value.expression;
  return value;
}
