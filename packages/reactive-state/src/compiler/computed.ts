import {
  type ArrowFunction,
  type BinaryExpression,
  type CallExpression,
  type ElementAccessExpression,
  type EntityName,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isQualifiedName,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  isTypeOfExpression,
  isTypeQueryNode,
  isTypeReferenceNode,
  type Node,
  type PropertyAccessExpression,
  SyntaxKind,
  type VariableDeclaration,
} from 'typescript/ast';

import {
  ALIKE,
  approximated,
  APPROXIMATED,
  checkAnsweredAlike,
  checkComparator,
  checkRadix,
  handedParse,
  INTROSPECTORS,
} from './alike.ts';
import {
  BOUNDED,
  type Called,
  checkBounded,
  checkBoundedName,
  checkCallbackThis,
  checkHandedBounded,
  firstLine,
  globalOf,
  literalName,
  namesNamespace,
  type Refuse,
  unwrapped,
} from './bounded.ts';
import { functionOf } from './statements.ts';

/**
 * The grammar of what a dynamic site is computed by — what the browser computes of its states, which
 * the authority computes again in place (`derive.ts`), and what its element is given: names,
 * literals, templates, objects and arrays, property reads, calls — of the application's shared
 * modules, of a value's methods, given functions of an expression — and the operators. Nothing that
 * waits, assigns, constructs or runs anything else: a value computed twice, once on each side or
 * again of the same inputs, is the same value; and nothing larger than the inputs a page sends,
 * which the authority computes it of as they come.
 */

/** What a refusal says the authority computes a site's values by. */
export const COMPUTED_BY =
  "the authority computes again, of the local states it is made of, each value a dynamic site is rendered of — what it reads that the browser computes, what its element is given: of names, literals, templates, objects and arrays, property reads, calls of the application's shared modules and of a value's methods — a method given functions of an expression — and the operators, and nothing that waits, assigns or runs anything else";

/** The prefix operators that assign. */
export const INCREMENTS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.MinusMinusToken,
  SyntaxKind.PlusPlusToken,
]);

/** The methods that change the array they are called on: a state's, which the authority holds as sent. */
export const MUTATORS: ReadonlySet<string> = new Set([
  'copyWithin',
  'fill',
  'pop',
  'push',
  'reverse',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** The functions of `Object` that change the object they are given first. */
export const OBJECT_MUTATORS: ReadonlySet<string> = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
  'setPrototypeOf',
]);

/**
 * The functions of `Object` that change the object they are given first, as the grammar refuses
 * them: `OBJECT_MUTATORS`, which a write in the server part is read by too, and those that lock what
 * it holds of itself beyond its value — frozen, sealed, extensible — which the browser's state would
 * keep, and the authority's copy, frozen already, would not tell.
 */
const OBJECT_CHANGERS: ReadonlySet<string> = new Set([
  ...OBJECT_MUTATORS,
  'freeze',
  'preventExtensions',
  'seal',
]);

/** Refuses what `node` is computed by beyond the grammar of what a site's values are computed by. */
export function checkComputed(node: Node, refuse: Refuse): void {
  if (isComputedLeaf(node)) {
    if (isIdentifier(node)) {
      checkName(node, refuse);
    }
    if (node.kind === SyntaxKind.BigIntLiteral) {
      refuse(
        `\`${firstLine(node)}\` is an integer of \`BigInt\`, which no JSON holds — what a site's element is given, a list's key, what a page sends — and which nothing a page sends is made into, and ${COMPUTED_BY}. Write a number, \`2\`, or text: \`'2'\`.`,
      );
    }
    return;
  }
  const children = childrenOf(node, refuse);
  if (children === undefined) {
    refuse(`\`${firstLine(node)}\` is no such value: ${COMPUTED_BY}.`);
  }
  for (const child of children) {
    checkComputed(child, refuse);
  }
}

/**
 * The globals whose members the grammar holds to rules — `Math.random`, `Object.assign`,
 * `Array.from` — which are read as what a member is read of alone: as a value of their own, under
 * another name or handed on, their members would escape the rules.
 */
const GUARDED: ReadonlySet<string> = new Set(['Array', 'Math', 'Object']);

/** Refuses a name no value of the grammar's reads: `BigInt`, or a guarded global as a value of its own. */
function checkName(name: Identifier, refuse: Refuse): void {
  checkBoundedName(name, refuse);
  const global = globalOf(name);
  if (global === 'parseInt' && !isCallee(name)) {
    refuse(handedParse('parseInt'));
  }
  if (global !== undefined && GUARDED.has(global) && !isMemberTarget(name)) {
    refuse(
      `\`${name.text}\` is read here as a value of its own — under another name, or handed on — where the rules its members are held to would not see them, and ${COMPUTED_BY}. Read the member where it is used: \`Math.max(…)\`, \`Object.keys(…)\`, \`Array.isArray(…)\`.`,
    );
  }
  if (global === 'String' && !isMemberTarget(name) && !isCallee(name) && !isArgument(name)) {
    refuse(
      `\`String\` is read here as a value of its own — in an object or an array, or of an operator, \`(flag ? String : x).raw(…)\` — where the rules its members are held to (\`String.raw\`) would not see them, and ${COMPUTED_BY}. Call it, read its member where it is used, or give it to a call as it is: \`items.map(String)\`.`,
    );
  }
}

/** Whether `node`, within the parentheses and casts around it, is what a call is given. */
function isArgument(node: Node): boolean {
  const each = outermost(node);
  const { parent } = each;
  return isCallExpression(parent) && parent.expression !== each;
}

/** `node` within the parentheses and casts around it: the outermost of them. */
function outermost(node: Node): Node {
  let each = node;
  while (
    isParenthesizedExpression(each.parent) ||
    isAsExpression(each.parent) ||
    isSatisfiesExpression(each.parent) ||
    isNonNullExpression(each.parent)
  ) {
    each = each.parent;
  }
  return each;
}

/** Whether `node`, within the parentheses and casts around it, is what a member is read of. */
function isMemberTarget(node: Node): boolean {
  const each = outermost(node);
  const { parent } = each;
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === each
  );
}

/** Whether `node`, within the parentheses and casts around it, is what a call calls. */
function isCallee(node: Node): boolean {
  const each = outermost(node);
  return isCallExpression(each.parent) && each.parent.expression === each;
}

/** Whether `node` is a name or a literal, which computes nothing. */
function isComputedLeaf(node: Node): boolean {
  return (
    isIdentifier(node) ||
    isStringLiteral(node) ||
    isNumericLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isOmittedExpression(node) ||
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NullKeyword ||
    node.kind === SyntaxKind.BigIntLiteral
  );
}

/** What `node`'s value is computed of, each held to the grammar in turn; none where it is no such value. */
function childrenOf(node: Node, refuse: Refuse): readonly Node[] | undefined {
  if (isTemplateExpression(node)) {
    return node.templateSpans.map((span) => span.expression);
  }
  if (isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) => propertyOf(property, refuse));
  }
  if (isArrayLiteralExpression(node)) {
    return node.elements.map((element) =>
      isSpreadElement(element) ? element.expression : element,
    );
  }
  if (isCallExpression(node)) {
    checkCall(node, refuse);
    return [node.expression, ...node.arguments.map((argument) => argumentOf(argument, refuse))];
  }
  if (isBinaryExpression(node)) {
    return operandsOf(node, refuse);
  }
  if (isPrefixUnaryExpression(node)) {
    if (INCREMENTS.has(node.operator)) {
      refuse(`An increment assigns, and ${COMPUTED_BY}.`);
    }
    return [node.operand];
  }
  if (isConditionalExpression(node)) {
    return [node.condition, node.whenTrue, node.whenFalse];
  }
  if (isElementAccessExpression(node)) {
    checkReference(node, refuse);
    return [node.expression, node.argumentExpression];
  }
  if (isPropertyAccessExpression(node)) {
    checkReference(node, refuse);
  }
  return wrapped(node);
}

/**
 * The names that reach what made a value, or what it is made of — `Function`, through a function's
 * `constructor`, which runs the text it is given — or define what it answers: read or called by
 * any of them, a value is no value of the grammar's.
 */
const REACHING: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
]);

/** The globals some members of which the grammar holds to rules, handed on too (`checkHandedGlobal`). */
const RULED_GLOBALS: ReadonlySet<string> = new Set(['Array', 'Math', 'Number', 'Object', 'String']);

/**
 * Refuses a reference to a function no value both sides compute calls, where it is not called
 * itself but handed on, to be called where the compile does not see it, as a call of it would be
 * refused (`checkCall`): `Math.random`, `Array.from`, `Object.assign`, `Object.isFrozen` and their
 * kin, whatever reads them. A read of a value's property of another name is a value's, as a field
 * of the data may be named `sort`; a method called through `.call`, `.apply` or `.bind` is
 * refused as that call (`checkBounded`).
 */
function checkReference(
  node: ElementAccessExpression | PropertyAccessExpression,
  refuse: Refuse,
): void {
  const name = isPropertyAccessExpression(node) ? node.name.text : literalName(node);
  if (name !== undefined && REACHING.has(name)) {
    refuse(
      `\`.${name}\` reaches what made a value, or what it is made of — \`Function\` among them, which runs the text it is given — and ${COMPUTED_BY}.`,
    );
  }
  if (isCallee(node) || namesNamespace(unwrapped(node.expression))) {
    return;
  }
  const global = globalOf(unwrapped(node.expression));
  if (name === undefined) {
    if (global !== undefined && RULED_GLOBALS.has(global)) {
      refuse(
        `\`${firstLine(node)}\` reads a member of \`${global}\` by a name the compile cannot read, handed on to be called where the compile does not see it — one of those it holds to rules, \`Math.random\`, \`Object.isFrozen\`, among what it may be — and ${COMPUTED_BY}. Name the member: \`${global}.max\`.`,
      );
    }
    return;
  }
  if (name === 'parseInt') {
    refuse(handedParse(`.${name}`));
  }
  if (global !== undefined) {
    checkHandedGlobal(global, name, refuse);
  }
}

/** Refuses a member of the global `global` handed on, where a call of it would be refused. */
function checkHandedGlobal(global: string, name: string, refuse: Refuse): void {
  checkHandedBounded(global, name, refuse);
  if (global === 'Math' && APPROXIMATED.has(name)) {
    refuse(approximated(`Math.${name}`));
  }
  if (global === 'Math' && name === 'random') {
    refuse(
      `\`Math.random\` answers of chance wherever it is called, and it is handed on here, to be called where the compile does not see it: ${ALIKE}.`,
    );
  }
  if (global === 'Object' && OBJECT_CHANGERS.has(name)) {
    refuse(
      `\`Object.${name}\` changes the object it is given first wherever it is called, and it is handed on here, to be called where the compile does not see it, and ${COMPUTED_BY}.`,
    );
  }
  if (global === 'Object' && INTROSPECTORS.has(name)) {
    refuse(
      `\`Object.${name}\` answers of what an object holds beyond its value, and it is handed on here, to be called where the compile does not see it: ${ALIKE}.`,
    );
  }
}

/** What an expression that wraps one other is computed of: that one. */
function wrapped(node: Node): readonly Node[] | undefined {
  return isPropertyAccessExpression(node) ||
    isParenthesizedExpression(node) ||
    isNonNullExpression(node) ||
    isTypeOfExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node)
    ? [node.expression]
    : undefined;
}

/** The key a property is written with — a name, text, or text in brackets, `['length']` — where the code writes it. */
function keyText(name: Node): string | undefined {
  if (isComputedPropertyName(name)) {
    const expression = unwrapped(name.expression);
    return isStringLiteral(expression) || isNoSubstitutionTemplateLiteral(expression)
      ? expression.text
      : undefined;
  }
  return propertyKey(name);
}

/** The key a property is written with, where it is written as a name or as text: not computed. */
function propertyKey(name: Node): string | undefined {
  return isIdentifier(name) || isStringLiteral(name) ? name.text : undefined;
}

/** What an object literal's property is computed of. */
function propertyOf(property: Node, refuse: Refuse): readonly Node[] {
  if (
    (isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) &&
    keyText(property.name) === 'length'
  ) {
    refuse(
      `\`length:\` makes an object stand for an array as long as it says to the language's methods that read one — \`[].concat(…)\` of one made spreadable, \`[...…]\` of one that iterates as an array — and ${BOUNDED}. Name the entry otherwise, or make the array of one the inputs hold: \`items.slice(0, count)\`.`,
    );
  }
  if (isPropertyAssignment(property) && propertyKey(property.name) === '__proto__') {
    refuse(
      `\`__proto__:\` makes the object of another, which holds what it does not enumerate as its own, and ${COMPUTED_BY}. Name the key in brackets, \`['__proto__']\`, for an entry of that name.`,
    );
  }
  if (isPropertyAssignment(property)) {
    return property.name.kind === SyntaxKind.ComputedPropertyName
      ? [property.name.expression, property.initializer]
      : [property.initializer];
  }
  if (isSpreadAssignment(property)) {
    return [property.expression];
  }
  if (isShorthandPropertyAssignment(property)) {
    return [property.name];
  }
  return refuse(`An object's method or accessor is a function, and ${COMPUTED_BY}.`);
}

/**
 * Refuses a call that changes what it is called on — a state the authority holds as the page sent
 * it, which the browser would change for good — that answers of the locale, of the Unicode data its
 * engine ships, of chance or of what an object holds beyond its value, that orders by a comparator
 * (`checkComparator`), or that makes more than it is given (`checkBounded`); and a call made
 * optionally, `?.(…)`, of what may be no function.
 */
function checkCall(call: CallExpression, refuse: Refuse): void {
  if (call.questionDotToken !== undefined) {
    refuse(
      `\`${firstLine(call)}\` calls what may be no function, \`?.(…)\`, where a site's code calls what it calls as it is — a value's method, a global's or a \`shared\` module's function — and ${COMPUTED_BY}. Call it, \`item.at(0)\`, or read what it is called on optionally: \`item?.at(0)\`.`,
    );
  }
  const callee = unwrapped(call.expression);
  if (globalOf(callee) === 'Array') {
    refuse(
      `\`Array(…)\` makes an array as long as the number it is given says, and ${BOUNDED}. Write the array, or compute it of one the inputs hold: \`items.map(…)\`, \`items.slice(0, count)\`.`,
    );
  }
  // `(items.sort)()`, `items.sort!()` and `(items.sort as Sort)()` call the method as `items.sort()`.
  const called = methodOf(callee, refuse);
  // `helpers.search(…)`: a function of a module's namespace, which no rule of a value's methods names.
  if (called !== undefined && namesNamespace(called.target)) {
    return;
  }
  checkRadix(call, called?.method ?? globalOf(callee), refuse);
  if (called === undefined) {
    return;
  }
  checkBounded(call, called, refuse);
  checkCallbackThis(call, called.method, refuse);
  const { method, target } = called;
  const global = globalOf(target);
  if (MUTATORS.has(method) && !isArrayLiteralExpression(target)) {
    refuse(
      `\`.${method}()\` changes the array it is called on — a state's, which the authority holds as the page sent it — and ${COMPUTED_BY}. Call it on a copy, \`[...items].${method}(…)\`, or call what answers a new array: \`toSorted\`, \`toReversed\`, \`toSpliced\`, \`with\`.`,
    );
  }
  if (global === 'Object' && method === 'assign') {
    refuse(
      `\`Object.assign()\` sets each entry it copies on what it is given first — an own \`__proto__\` of a site's input among them, a key JSON holds, which makes that object one of another prototype, no JSON — and ${COMPUTED_BY}. Copy with a spread, which writes each entry as its own: \`{ ...a, ...b }\`.`,
    );
  }
  if (global === 'Object' && OBJECT_CHANGERS.has(method)) {
    const [first] = call.arguments;
    if (first === undefined || !isObjectLiteralExpression(unwrapped(first))) {
      refuse(
        `\`Object.${method}()\` changes the object it is given first — a state's, which the authority holds as the page sent it — and ${COMPUTED_BY}. Give it a new object first: \`Object.${method}({}, …)\`.`,
      );
    }
  }
  checkAnsweredAlike(method, global, refuse);
  checkComparator(call, method, refuse);
}

/**
 * The method `callee` calls, by its name, and what it is called on: `.sort` of `items.sort`, or of
 * `items['sort']`; none where `callee` calls no method. One called by a name the compile cannot
 * read — `items[name]()` — is refused, for what it calls cannot be told.
 */
function methodOf(callee: Expression, refuse: Refuse): Called | undefined {
  if (isPropertyAccessExpression(callee)) {
    return { method: callee.name.text, target: unwrapped(callee.expression) };
  }
  if (!isElementAccessExpression(callee)) {
    return undefined;
  }
  const name = unwrapped(callee.argumentExpression);
  if (!isStringLiteral(name) && !isNoSubstitutionTemplateLiteral(name)) {
    return refuse(
      `\`${firstLine(callee)}(…)\` calls a method by a name the compile cannot read, and ${COMPUTED_BY}. Call it by its name.`,
    );
  }
  return { method: name.text, target: unwrapped(callee.expression) };
}

/** What a call's argument is computed of: a function a method is given, by what it computes. */
function argumentOf(argument: Expression, refuse: Refuse): Node {
  if (!isArrowFunction(argument)) {
    return isSpreadElement(argument) ? argument.expression : argument;
  }
  checkCallback(argument, refuse);
  return argument.body;
}

/** What a binary expression is computed of: its operands, of an operator that assigns nothing. */
function operandsOf(node: BinaryExpression, refuse: Refuse): readonly Node[] {
  const operator = node.operatorToken.kind;
  if (operator === SyntaxKind.AsteriskAsteriskToken) {
    refuse(approximated('**'));
  }
  if (
    operator === SyntaxKind.CommaToken ||
    (operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment)
  ) {
    refuse(`\`${node.operatorToken.getText()}\` assigns, and ${COMPUTED_BY}.`);
  }
  return [node.left, node.right];
}

/** Refuses a function a method is given beyond one of plain parameters and an expression. */
function checkCallback(fn: ArrowFunction, refuse: Refuse): void {
  if (fn.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true) {
    refuse(`A function a method is given is async, answering a promise, and ${COMPUTED_BY}.`);
  }
  for (const parameter of fn.parameters) {
    if (
      !isIdentifier(parameter.name) ||
      parameter.initializer !== undefined ||
      parameter.dotDotDotToken !== undefined
    ) {
      refuse(
        `A function a method is given takes its parameters by name, with no default, and ${COMPUTED_BY}.`,
      );
    }
  }
  if (fn.body.kind === SyntaxKind.Block) {
    refuse(
      `A function a method is given computes an expression — \`item => …\` — and no statements, and ${COMPUTED_BY}.`,
    );
  }
}

/**
 * `text`, the text of `expression`, as a value written in place of a name: in parentheses where it
 * needs them — an operator's, an object's, a number's (`(1).toFixed()`) and an optional chain's,
 * which a read written after it would join (`(a?.b).c`).
 */
export function substituted(expression: Expression, text: string): string {
  let node: Expression = expression;
  while (isParenthesizedExpression(node)) {
    node = node.expression;
  }
  const access =
    (isPropertyAccessExpression(node) ||
      isElementAccessExpression(node) ||
      isCallExpression(node)) &&
    !chained(node);
  const operand =
    access ||
    isIdentifier(node) ||
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isTemplateExpression(node) ||
    isArrayLiteralExpression(node) ||
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NullKeyword;
  return operand ? text : `(${text})`;
}

/** Whether `node` is in an optional chain — `a?.b.c` — which a read written after it would join. */
export function chained(node: Expression): boolean {
  let each = node;
  while (
    isPropertyAccessExpression(each) ||
    isElementAccessExpression(each) ||
    isCallExpression(each) ||
    isNonNullExpression(each)
  ) {
    if (!isNonNullExpression(each) && each.questionDotToken !== undefined) {
      return true;
    }
    each = each.expression;
  }
  return false;
}

/** The value a constant a site's value is computed of holds, read as `name`: one by name, of no function. */
export function initializerOf(
  name: string,
  declaration: VariableDeclaration,
  refusing: { readonly what: string; readonly refuse: Refuse },
): Expression {
  const { initializer } = declaration;
  if (!isIdentifier(declaration.name) || functionOf(declaration) !== undefined) {
    refusing.refuse(
      `\`${name}\` is ${refusing.what} ${isIdentifier(declaration.name) ? 'that holds a function' : 'destructured'}, and ${COMPUTED_BY}. Compute the value itself, by name.`,
    );
  }
  if (initializer === undefined) {
    refusing.refuse(`\`${name}\` holds nothing to compute.`);
  }
  return initializer;
}

/**
 * Refuses a type in a hook's code that names what is declared within the hook's module but not at
 * its top — `local` tells which: a type parameter, a type of a block's — which the program, where
 * the value is computed in place, has no name for. A type of the top is the caller's to import, or
 * refuse, where it is read.
 */
export function checkTypes(node: Node, local: (name: string) => boolean, refuse: Refuse): void {
  if (isTypeReferenceNode(node) || isTypeQueryNode(node)) {
    const { text } = leftmostOf(isTypeReferenceNode(node) ? node.typeName : node.exprName);
    if (local(text)) {
      refuse(
        `the type \`${text}\` is declared within the hook, which the authority's program, where the value is computed again in place, has no name for. Declare it in a shared module of the application's, or leave it out of what the value is computed by.`,
      );
    }
  }
  node.forEachChild((child) => {
    checkTypes(child, local, refuse);
  });
}

/** The leftmost name of `name`: `Foo` of `Foo.Bar`. */
function leftmostOf(name: EntityName): Identifier {
  let node = name;
  while (isQualifiedName(node)) {
    node = node.left;
  }
  return node;
}
