import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isArrowFunction,
  isAsExpression,
  isElementAccessExpression,
  isIdentifier,
  isImportDeclaration,
  isNamespaceImport,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSpreadElement,
  isStringLiteral,
  type Identifier,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from 'typescript/ast';

import { VIEW_LIMITS } from '../program.ts';
import { declaredWithin } from './scope.ts';

/**
 * What of the grammar of a dynamic site's values (`computed.ts`) keeps what the authority computes
 * of the inputs a view sends — which it chooses, within `VIEW_LIMITS.bytes` — no larger than they
 * are: nothing as large as a number says — an integer of `BigInt` neither — no value repeated for
 * each entry of a value, no regular expression, no function called on what it was not given. What
 * one call makes, it makes whole before the program counts its answer; each value the code makes,
 * the program counts as it is made (`$.counted`, `compiler/counting.ts`, `authority/steps.ts`).
 */

/** Every name a declaration in each file gives, as `declaredWithin` reads it once. */
const DECLARED = new WeakMap<SourceFile, ReadonlySet<string>>();

/**
 * The global `node` reads, by its name: none where it is no name, or where a declaration in its
 * file gives that name, or an import of a value does — a prop named `Math` is the prop, and `Number`
 * imported of a module that module's. A read of such a name that no declaration in scope answers,
 * which would be the global's, the walk of the code refuses (`scope.ts`: a read is a global only
 * where nothing in the file declares that name), so none of the global's escapes the rules it is
 * held to here.
 */
export function globalOf(node: Node): string | undefined {
  if (!isIdentifier(node)) {
    return undefined;
  }
  const file = node.getSourceFile();
  let declared = DECLARED.get(file);
  if (declared === undefined) {
    const names = new Set(declaredWithin(file));
    for (const name of importedValues(file)) {
      names.add(name);
    }
    declared = names;
    DECLARED.set(file, declared);
  }
  return declared.has(node.text) ? undefined : node.text;
}

/**
 * The names `file`'s imports bind a value to: none of an import of a type alone (`import type`,
 * `import { type T }`), which binds nothing that runs — a read of that name is the global's.
 */
function importedValues(file: SourceFile): readonly string[] {
  const names: string[] = [];
  for (const statement of file.statements) {
    const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
      continue;
    }
    if (clause.name !== undefined) {
      names.push(clause.name.text);
    }
    const named = clause.namedBindings;
    if (named !== undefined && isNamespaceImport(named)) {
      names.push(named.name.text);
    } else if (named !== undefined) {
      names.push(
        ...named.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => element.name.text),
      );
    }
  }
  return names;
}

/** The names each file's imports bind a module's namespace to. */
const NAMESPACES = new WeakMap<SourceFile, ReadonlySet<string>>();

/**
 * Whether `node` names a module's namespace its file imports — `helpers` of `import * as helpers`
 * — whose members are the module's functions: none of them a value's method, whatever its name.
 */
export function namesNamespace(node: Node): boolean {
  if (!isIdentifier(node)) {
    return false;
  }
  const file = node.getSourceFile();
  let names = NAMESPACES.get(file);
  if (names === undefined) {
    names = new Set(
      file.statements.flatMap((statement) => {
        const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
        const named = clause?.namedBindings;
        return named !== undefined &&
          clause?.phaseModifier !== SyntaxKind.TypeKeyword &&
          isNamespaceImport(named)
          ? [named.name.text]
          : [];
      }),
    );
    NAMESPACES.set(file, names);
  }
  return names.has(node.text);
}

/** The longest a refusal quotes of the code it refuses. */
const QUOTED = 60;

/** Refuses what is computed beyond the grammar. */
export type Refuse = (message: string) => never;

/** A method called, by its name, and what it is called on. */
export interface Called {
  readonly method: string;
  readonly target: Expression;
}

/** The ways a function is called that the compile does not see as a call of it. */
const INDIRECT: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/** The functions of `Array` that make an array as long as what they are given says it is. */
const ARRAY_MAKERS: ReadonlySet<string> = new Set(['from', 'fromAsync']);

/**
 * The functions of `Object` that make what an object holds out of its own enumerated entries — a
 * property defined not enumerable, an object made of another — which no step counts.
 */
const HIDING: ReadonlySet<string> = new Set([
  'create',
  'defineProperties',
  'defineProperty',
  'setPrototypeOf',
]);

/** The methods of text that make text as long as the number they are given first says. */
const SIZED_TEXT: ReadonlySet<string> = new Set(['padEnd', 'padStart', 'repeat']);

/**
 * The methods of text that make a regular expression of what they are given: one the code writes
 * too may take without end to try on text a view sends, which one call of it computes whole.
 */
const PATTERNED: ReadonlySet<string> = new Set(['match', 'matchAll', 'search']);

/** The methods of a regular expression, of which none is the code's own (no literal is). */
const REGEXP_METHODS: ReadonlySet<string> = new Set(['exec', 'test']);

/** The methods of text that take a regular expression first, as well as text. */
const PATTERN_TAKERS: ReadonlySet<string> = new Set(['replace', 'replaceAll', 'split']);

/** Whether `node` is text the code writes. */
function isTextLiteral(node: Node): node is NoSubstitutionTemplateLiteral | StringLiteral {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node);
}

/**
 * The methods that repeat a value they are given for each entry of what they are called on, by the
 * place of that value among their arguments: `join`'s separator, `fill`'s value, `replaceAll`'s
 * replacement — which one call repeats whole before the program counts what it answers.
 */
const REPEATING: ReadonlyMap<string, number> = new Map([
  ['fill', 0],
  ['join', 0],
  ['replaceAll', 1],
]);

/** What a refusal of what could cost the authority beyond the inputs a page sends says. */
export const BOUNDED =
  "the authority computes what a dynamic site reads again of the inputs a page's view sends, whatever it chooses to send, and makes nothing of them larger than they are, nor works on them without end: no array, text or integer as large as a number says, and no regular expression";

/**
 * The language's functions that read each value they are given, as many as there are — each made a
 * number of its text: handed on to an array's method, one reads each element, its index and the
 * whole array each time it is called, which no step counts.
 */
const VARIADIC: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Math', new Set(['max', 'min'])],
  ['String', new Set(['fromCharCode', 'fromCodePoint'])],
]);

/**
 * Refuses a member of the global `global` handed on, to be called where the compile does not see it,
 * where a call of it would make of what it is given more than it is: the symbols of an object
 * (`checkSymbols`), `String.raw`, what makes an object of its entries (`HIDING`), an array as long
 * as a number says (`ARRAY_MAKERS`), and a function that reads as many values as it is given
 * (`VARIADIC`) — `items.map(Math.max)` makes a number of the whole array's text for each item.
 */
export function checkHandedBounded(global: string, name: string, refuse: Refuse): void {
  checkSymbols(global, name, refuse);
  if (global === 'String' && name === 'raw') {
    refuse(
      `\`String.raw\` makes text of as many segments as what it is given says it holds, and it is handed on here, to be called where the compile does not see it: ${BOUNDED}.`,
    );
  }
  if (global === 'Object' && HIDING.has(name)) {
    refuse(
      `\`Object.${name}\` makes what an object holds out of its own enumerated entries wherever it is called, and it is handed on here, to be called where the compile does not see it: ${BOUNDED}.`,
    );
  }
  if (global === 'Array' && ARRAY_MAKERS.has(name)) {
    refuse(
      `\`Array.${name}\` makes an array as long as what it is given says it is, and it is handed on here, to be called where the compile does not see it: ${BOUNDED}.`,
    );
  }
  if (VARIADIC.get(global)?.has(name) === true) {
    refuse(
      `\`${global}.${name}\` reads each value it is given, as many as there are, and it is handed on here, to be called where the compile does not see it — by an array's method, with each element, its index and the whole array, made a number of its text each time — while ${BOUNDED}. Call it of the element: \`(n) => ${global}.${name}(n)\`.`,
    );
  }
}

/**
 * Refuses `Object.getOwnPropertySymbols`, called or handed on: it answers the symbols an object
 * holds — `Symbol.iterator` of an array's prototype among them — which make an object stand for
 * an array to the language's methods (`[...{ [iterator]: [].values, length }]`), as long as a
 * number a view sends says, where the code reaches no symbol of its own otherwise.
 */
function checkSymbols(global: string | undefined, name: string, refuse: Refuse): void {
  if (global === 'Object' && name === 'getOwnPropertySymbols') {
    refuse(
      `\`Object.getOwnPropertySymbols\` answers the symbols an object holds — \`Symbol.iterator\` of an array's prototype among them — of which an object of a number a view sends stands for an array as long to the language's methods, and ${BOUNDED}. Read an object's entries: \`Object.keys(…)\`, \`Object.entries(…)\`.`,
    );
  }
}

/**
 * Refuses a call that makes of what it is given more than it is (`BOUNDED`), whole before the program
 * counts what it answers (`$.counted`): an array or text as long as a number says, unless the code
 * writes the number; a value repeated for each entry of an array or of text, unless the code writes
 * it; a regular expression; and a function called through `.call`, `.apply` or `.bind`, which calls
 * it on whatever it is given — an array's method on what is no array, as long as it says it is.
 */
export function checkBounded(
  call: CallExpression,
  { method, target }: Called,
  refuse: Refuse,
): void {
  const [given] = call.arguments;
  const first = given === undefined ? undefined : unwrapped(given);
  if (INDIRECT.has(method)) {
    refuse(
      `\`${calledName(target)}\` is called by \`.${method}(…)\`, which calls it on whatever it is given — an array's method on what is no array, as long as it says it is — and ${BOUNDED}. Call it by its name.`,
    );
  }
  checkSymbols(globalOf(target), method, refuse);
  if (globalOf(target) === 'Object' && HIDING.has(method)) {
    refuse(
      `\`Object.${method}()\` makes what an object holds out of its own enumerated entries — a property defined not enumerable, an object made of another — which no step counts, and ${BOUNDED}. Write the object of its entries: \`{ a: … }\`, \`Object.fromEntries(…)\`.`,
    );
  }
  if (method === 'raw' && globalOf(target) === 'String') {
    refuse(
      `\`String.raw()\` makes text of as many segments as what it is given says it holds — \`{ raw: { length: count } }\` — and ${BOUNDED}. Write the text: a template literal.`,
    );
  }
  if (globalOf(target) === 'Array' && ARRAY_MAKERS.has(method)) {
    refuse(
      `\`Array.${method}()\` makes an array as long as what it is given says it is — \`{ length: count }\` — and ${BOUNDED}. Copy an array with \`[...items]\`, or map it: \`items.map(…)\`.`,
    );
  }
  if (SIZED_TEXT.has(method)) {
    checkSized(first, { method, target }, refuse);
  }
  checkRepeating(call, method, refuse);
  checkPatterns(method, first, refuse);
  checkSubstitution(method, call, refuse);
}

/**
 * The most characters a separator or a replacement the code writes holds — `.join(', ')`,
 * `.replaceAll('&', '&amp;')` — which one call writes again for each entry or match of what it is
 * called on, so makes of what a view sends no more than so many times it.
 */
const WRITTEN_TEXT_LENGTH = 16;

/**
 * Refuses text `.repeat`, `.padStart` or `.padEnd` makes, whole before the program counts it, of
 * what the code cannot tell the length of — a number it does not write; `.repeat` of text it does
 * not write, as many times what a view sends — or longer than the steps a call of a site's function
 * may spend (`VIEW_LIMITS.steps`), which the count would refuse once it was made.
 */
function checkSized(
  first: Expression | undefined,
  { method, target }: Called,
  refuse: Refuse,
): void {
  if (first === undefined || !isNumericLiteral(first)) {
    return refuse(
      `\`.${method}()\` makes text as long as the number it is given says, and ${BOUNDED}. Give it a number the code writes — \`.padStart(2, '0')\` — or slice text as long as it may be: \`'★★★★★'.slice(0, rating)\`.`,
    );
  }
  const text = unwrapped(target);
  if (method === 'repeat' && !isTextLiteral(text)) {
    return refuse(
      `\`.repeat(${first.text})\` repeats text the code does not write — of what a view sends, as long as it is, so many times — which one call makes whole, and ${BOUNDED}. Repeat text the code writes, \`'★'.repeat(5)\`, or join what it repeats: \`text + text\`.`,
    );
  }
  const length =
    Number(first.text) * (method === 'repeat' && isTextLiteral(text) ? text.text.length : 1);
  if (length > VIEW_LIMITS.steps) {
    refuse(
      `\`.${method}(${first.text})\` makes text of ${String(length)} characters, which one call makes whole before it is counted — more than the ${String(VIEW_LIMITS.steps)} steps a call of a site's function may spend — and ${BOUNDED}. Make it shorter.`,
    );
  }
}

/**
 * Refuses what a method repeats for each entry of what it is called on (`REPEATING`) but what the
 * code writes, and text the code writes for `.join` and `.replaceAll` longer than
 * `WRITTEN_TEXT_LENGTH`, which one call writes again for each entry or match of what a view sends.
 */
function checkRepeating(call: CallExpression, method: string, refuse: Refuse): void {
  const repeated = REPEATING.get(method);
  const given = repeated === undefined ? undefined : call.arguments[repeated];
  const value = given === undefined ? undefined : unwrapped(given);
  if (value === undefined) {
    return;
  }
  if (!isWritten(value)) {
    refuse(
      `\`.${method}()\` repeats what it is given for each entry of what it is called on, and ${BOUNDED}. Give it what the code writes — \`.join(', ')\`, \`.fill(0)\` — or a function, which is counted.`,
    );
  }
  if (method !== 'fill' && isTextLiteral(value) && value.text.length > WRITTEN_TEXT_LENGTH) {
    refuse(
      `\`.${method}()\` writes text of ${String(value.text.length)} characters again for each entry or match of what it is called on — what a view sends — more than the ${String(WRITTEN_TEXT_LENGTH)} it may hold, which one call makes whole before it is counted, and ${BOUNDED}. Write it shorter.`,
    );
  }
}

/**
 * Refuses the text `.replaceAll` is given to put in place of each match where it inserts what
 * stands before or after the match — `` $` ``, `$'` — which, of a match at each character, makes
 * text as long as the square of what a view sends. `$$` is a `$` of its own.
 */
function checkSubstitution(method: string, call: CallExpression, refuse: Refuse): void {
  const given = method === 'replaceAll' ? call.arguments[1] : undefined;
  const replacement = given === undefined ? undefined : unwrapped(given);
  if (
    replacement === undefined ||
    !(isStringLiteral(replacement) || isNoSubstitutionTemplateLiteral(replacement))
  ) {
    return;
  }
  const { text } = replacement;
  for (let at = text.indexOf('$'); at !== -1; at = text.indexOf('$', at + 2)) {
    const next = text[at + 1];
    if (next === '`' || next === "'") {
      refuse(
        `\`.replaceAll()\` is given \`$${next}\`, which puts what stands ${next === '`' ? 'before' : 'after'} each match in its place — of a match at each character, text as long as the square of what a view sends — and ${BOUNDED}. Write what it puts there: \`.replaceAll('-', ' ')\`.`,
      );
    }
  }
}

/**
 * Refuses a regular expression in what a site is computed of: one's methods, which none but the
 * server part's or a module's are, and what text's methods would take for one — given a value, or
 * made of what they are given.
 */
function checkPatterns(method: string, first: Node | undefined, refuse: Refuse): void {
  if (REGEXP_METHODS.has(method)) {
    refuse(
      `\`.${method}()\` is a regular expression's method — one the server part or a module made — whose pattern may take without end to try on text a view sends, and ${BOUNDED}. Test for text with \`.includes(…)\`, \`.startsWith(…)\` or \`.endsWith(…)\`.`,
    );
  }
  if (PATTERN_TAKERS.has(method) && (first === undefined || !isTextLiteral(first))) {
    refuse(
      `\`.${method}()\` is given what may be a regular expression — one the server part or a module made — whose pattern may take without end to try on text a view sends, and ${BOUNDED}. Give it text the code writes: \`.${method}(', ', …)\`.`,
    );
  }
  if (PATTERNED.has(method)) {
    refuse(
      `\`.${method}()\` makes a regular expression of what it is given, which a pattern the code writes too may take without end to try on text a view sends, and ${BOUNDED}. Test for text with \`.includes(…)\`, \`.startsWith(…)\` or \`.endsWith(…)\`.`,
    );
  }
}

/**
 * Refuses `BigInt`, which makes an integer of a number as large as the number says, which one
 * operation on it — a shift, a power — computes whole.
 */
export function checkBoundedName(name: Identifier, refuse: Refuse): void {
  if (globalOf(name) === 'BigInt') {
    refuse(
      `\`BigInt\` makes an integer of a number — \`1n << BigInt(count)\`, \`2n ** BigInt(count)\` — as large as the number says, which one operation computes whole, and ${BOUNDED}. Compute it of numbers.`,
    );
  }
}

/**
 * Whether `node` is what the code writes as it is: a literal, a number of its sign, `-1`, or a
 * function, which is counted.
 */
function isWritten(node: Expression): boolean {
  return (
    isArrowFunction(node) ||
    isStringLiteral(node) ||
    isNoSubstitutionTemplateLiteral(node) ||
    isNumericLiteral(node) ||
    isSignedNumber(node) ||
    node.kind === SyntaxKind.TrueKeyword ||
    node.kind === SyntaxKind.FalseKeyword ||
    node.kind === SyntaxKind.NullKeyword
  );
}

/** Whether `node` is a number the code writes of its sign: `-1`, `+1`. */
function isSignedNumber(node: Expression): boolean {
  return (
    isPrefixUnaryExpression(node) &&
    (node.operator === SyntaxKind.MinusToken || node.operator === SyntaxKind.PlusToken) &&
    isNumericLiteral(unwrapped(node.operand))
  );
}

/**
 * The method `callee` reads, by its name or by text in brackets — `headers.has`, `headers['has']` —
 * and what it reads it of; none of another callee, nor of a key the code computes.
 */
export function calledMember(
  callee: Expression,
): { readonly name: string; readonly of: Expression } | undefined {
  if (isPropertyAccessExpression(callee)) {
    return { name: callee.name.text, of: callee.expression };
  }
  const name = isElementAccessExpression(callee) ? literalName(callee) : undefined;
  return name === undefined || !isElementAccessExpression(callee)
    ? undefined
    : { name, of: callee.expression };
}

/** How a refusal names what `target` is: `.sort` of `items.sort`, anything else as it is written. */
function calledName(target: Expression): string {
  if (isPropertyAccessExpression(target)) {
    return `.${target.name.text}`;
  }
  const name = isElementAccessExpression(target) ? literalName(target) : undefined;
  return name === undefined ? firstLine(target) : `.${name}`;
}

/** `node` within the parentheses, the casts and the `!` that wrap it. */
export function unwrapped(node: Expression): Expression {
  let each = node;
  while (
    isParenthesizedExpression(each) ||
    isAsExpression(each) ||
    isSatisfiesExpression(each) ||
    isNonNullExpression(each)
  ) {
    each = each.expression;
  }
  return each;
}

/** The name an element access reads by, where it is written as text: `'sort'` of `items['sort']`. */
export function literalName(node: ElementAccessExpression): string | undefined {
  const name = unwrapped(node.argumentExpression);
  return isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name) ? name.text : undefined;
}

/** The first line of `node`'s text, as a refusal quotes it. */
export function firstLine(node: Node): string {
  const [first = ''] = node.getText().split('\n', 1);
  return first.length > QUOTED ? `${first.slice(0, QUOTED)}…` : first;
}

/** The methods of an array that call the function they are given first on what they are given next. */
const CALLING_ON: ReadonlySet<string> = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
]);

/**
 * Refuses a call of an array's method that calls a function it is given on what it is given next —
 * `items.map(fn, target)` — but an arrow function, which has no `this` of its own: a method handed
 * on, `[].push`, would change `target`, a state's, which the authority holds as the page sent it.
 */
export function checkCallbackThis(call: CallExpression, method: string, refuse: Refuse): void {
  if (!CALLING_ON.has(method)) {
    return;
  }
  const [callback, on] = call.arguments;
  const arrow = callback !== undefined && isArrowFunction(unwrapped(callback));
  const spread = call.arguments.some((argument) => isSpreadElement(argument));
  if (spread || (on !== undefined && !arrow)) {
    refuse(
      `\`.${method}(…)\` is given what the function it is given first is called on — its \`this\` — where that is no arrow function: a method handed on, \`[].push\`, would change what it is given, and ${BOUNDED}. Give it the callback alone, an arrow function: \`items.${method}((item) => …)\`.`,
    );
  }
}
