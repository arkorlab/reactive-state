import {
  type BinaryExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isTemplateExpression,
  type Node,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import type { Fail } from './errors.ts';
import { isFunctionLike } from './reach.ts';
import { asStatus, madeStatus, type StatusGlobal } from './response-status.ts';
import { literal, unusedName } from './splice.ts';

/**
 * A guard's own answer — `return new Response(body, { status, headers })` before `await next()` —
 * as the guard program answers it: a `ResponseDescriptor` (`{ status, headers, body }`), which the
 * host makes the response of — a body of text with the content type `new Response(text)` gives it
 * where the guard names none, and no body with none; a body of a condition as each of its branches
 * is; and a body the guard computes as what it holds once the guard runs, text or none, the guard
 * throwing for anything else. Its status is the one `new Response` makes of what the init gives
 * (`madeStatus`: `403.5` is 403), and thrown for as it throws. What it cannot carry over as data —
 * a body that is no text on a branch, headers it cannot list, an init it cannot read — is refused,
 * rather than answered otherwise.
 */

/** The header that names a body's type, as `Headers` compares names: in lower case. */
const CONTENT_TYPE = 'content-type';

/** The content type `new Response(text)` gives a body of text where its init names none. */
const TEXT_TYPE = 'text/plain;charset=UTF-8';

const RESPONSE_ONLY =
  'A guard — what a route middleware runs before `next` — answers by `return new Response(body, { status, headers })`, or by a refusal it throws (`forbidden()`): the host makes the response of the status, the headers and the text the guard answers.';

const TEXT_BODY =
  "A guard's response holds text — a string, a template, or a value the guard computes (`message`, `JSON.stringify(…)`), which is checked to be text as the guard runs — or none. Its body is sent from the authority as text.";

const INIT_LITERAL =
  "A guard's response is given its status and its headers in an object literal — `{ status: 403, headers: { 'content-type': 'text/plain' } }` — which the compile reads: nothing else of a response's init is carried.";

/** The key an object literal sets its prototype by, written so: no property of its own. */
const PROTOTYPE_KEY = '__proto__';

const HEADERS_OWN =
  "A guard's response headers, in an object literal, are its own properties, each named once: `__proto__: …` sets the object's prototype, and a name written twice is its last — name such a header in a list of pairs (`[['name', 'value']]`).";

const HEADERS_INDEX =
  "A guard's response headers, in an object literal, are read in the order of the object's keys, which puts a name that is an array index — `404`, `'0'` — before every other, wherever it is written: name such a header in a list of pairs (`[['404', 'value']]`), which is read in the order it is written.";

/** 2³² − 1: what an array index is below, the length no array is longer than. */
const ARRAY_INDEX_BOUND = 4_294_967_295;
/** How an array index is written as a key: in digits, the first of which is no zero but in `0`. */
const INDEX_DIGITS = /^(?:0|[1-9]\d*)$/u;

const HEADERS_LITERAL =
  "A guard's response headers are an object literal of names and values, or a list of pairs: the compile lists them for the host.";

const HEADER_NAMES =
  "A guard's response of text names its headers as they are written — `[['vary', 'cookie']]` — unless one of them is its `content-type`: where none is, `new Response(text)` answers `content-type: text/plain;charset=UTF-8`, which the compile writes for the host where it reads that none is.";

/** One header of a guard's response, as the descriptor lists it. */
interface HeaderPair {
  /** The pair, as the descriptor writes it: `["vary", 'Cookie']`. */
  readonly text: string;
  /** Its name, where it is written as it is; none where the compile cannot read it. */
  readonly name: string | undefined;
  /** Its value, where it is written as text; none where it is anything else (`5`, `wait`). */
  readonly value: string | undefined;
  /** Where it is written. */
  readonly node: Node;
}

/** A header's name as `Headers` takes it: a token of HTTP's. */
const TOKEN = /^[\w!#$%&'*+.^`|~-]+$/u;
/** What `Headers` refuses in a header's value: a line break, a NUL, a character past a byte. */
const REFUSED_IN_VALUE = /[\0\n\r\u{100}-\u{10FFFF}]/u;

/** A global of the platform's the program names: its headers, its errors, its numbers and its math. */
type PlatformGlobal = 'Headers' | 'TypeError' | StatusGlobal;

/** The name the program writes a global of the platform's by (`globalNames`). */
type Named = (global: PlatformGlobal) => string;

/** What writing a guard's answer is given: where to refuse, and the names of the platform's globals. */
interface Writing {
  readonly fail: Fail;
  readonly named: Named;
}

/**
 * The names a guard's program writes the platform's globals by: each by its own, where the
 * middleware declares nothing of its name — anywhere, as `local` says — and otherwise by one it
 * leaves free, which the program binds to the global (`globals`, by the global's name): a guard's own
 * `Headers`, `TypeError` or `Number` is never the one the program makes a response by.
 */
function globalNames(local: (name: string) => boolean): {
  readonly named: Named;
  readonly globals: ReadonlyMap<string, string>;
} {
  const globals = new Map<string, string>();
  const named = (global: PlatformGlobal): string => {
    if (!local(global)) {
      return global;
    }
    const bound =
      globals.get(global) ??
      unusedName(global, (each) => local(each) || [...globals.values()].includes(each));
    globals.set(global, bound);
    return bound;
  };
  return { globals, named };
}

/** What the program throws where a header's name or value holds a character past a byte. */
const PAST_A_BYTE_THROWN =
  "A guard's response is given a header that holds a character past a byte.";

/**
 * The names and the values of a response's headers as the program makes them text where one is not
 * written as `Headers` keeps it, once the init is evaluated (`makingOf`): as WebIDL converts the
 * init's headers before its status, each name, then its value, made text once — `5` of
 * `'Retry-After': 5` is `'5'`, and a name whose text is new each time it is asked for is the one
 * `Response` takes — every pair before any is made a header of (`asHeaders`). Thrown for where that
 * throws: a symbol, a character past a byte.
 */
function asTexts(named: Named): string {
  const thrown = `throw new ${named('TypeError')}(${literal(PAST_A_BYTE_THROWN)});`;
  return `((headers: readonly (readonly [unknown, unknown])[]) => { const text = (part: unknown): string => { const made = \`\${part}\`; if (/[^\\x00-\\xFF]/u.test(made)) { ${thrown} } return made; }; return headers.map(([name, value]): readonly [string, string] => [text(name), text(value)]); })`;
}

/**
 * The headers of a response as the program makes them of their names and values made text
 * (`asTexts`), once the status is made and found in range (`makingOf`), as Fetch fills a response's
 * headers: each pair made a header of by `Headers`, its name and its value read back of the header it
 * made — a value's whitespace around it trimmed, a name in lower case. Thrown for where `Headers`
 * throws: a name that is no token, a line break or a NUL in a value.
 */
function asHeaders(named: Named): string {
  return `((headers: readonly (readonly [string, string])[]) => headers.map(([name, value]): readonly [string, string] => { const [made] = new ${named('Headers')}([[name, value]]); return made ?? ['', '']; }))`;
}

/**
 * Whether a header is written as `Headers` keeps it: its name a token, and its value text of no
 * whitespace around it, no line break, no NUL and no character past a byte.
 */
function keptAsWritten(pair: HeaderPair): boolean {
  const { name, value } = pair;
  return (
    name !== undefined &&
    value !== undefined &&
    TOKEN.test(name) &&
    value.trim() === value &&
    !REFUSED_IN_VALUE.test(value)
  );
}

/**
 * The list of `pairs`, then of `more` — written as `Headers` keeps them — as the program writes it
 * where the init writes it: as written, each pair made a header of only once the init is evaluated,
 * where one is not kept so (`madeOf`).
 */
function listOf(pairs: readonly HeaderPair[], more: readonly string[] = []): string {
  return `[${[...pairs.map((pair) => pair.text), ...more].join(', ')}]`;
}

/** The text a header's value is written as, where it is written as text: a string, a template. */
function writtenText(value: Expression | undefined): string | undefined {
  return value !== undefined && (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : undefined;
}

/** What a response's init gives a descriptor: its status, or its headers. */
type InitKey = 'headers' | 'status';

/** What a response's init gives: its status, and its headers, as written. */
interface Init {
  /**
   * The status as the program writes it: the one `new Response` makes of a number the init writes
   * (`known`), or the expression the guard computes it of, as written.
   */
  readonly status: string;
  /**
   * The status `new Response` makes, where the compile knows it: of a number written, or the 200 of
   * an init that gives none. None of one the guard computes, or of a number `new Response` throws
   * for, which the program makes — or throws for — as the guard runs (`madeOf`).
   */
  readonly known: number | undefined;
  /** Where the status is written; none for the 200 of an init that gives none. */
  readonly statusNode?: Expression;
  readonly headers: readonly HeaderPair[];
  /** What the init writes of the two, in the order it writes them: as `new Response` evaluates. */
  readonly written: readonly InitKey[];
}

/** What a descriptor holds of an init, beside its body. */
const INIT_KEYS: readonly InitKey[] = ['status', 'headers'];

/** The type a descriptor is checked as in the program, which a guard answers. */
const DESCRIPTOR_TYPE =
  '{ readonly body: string; readonly status: number; readonly headers: readonly (readonly [string, string])[] }';

/** The type of a status, and of headers, as a descriptor holds them. */
const INIT_TYPES: Readonly<Record<InitKey, string>> = {
  headers: 'readonly (readonly [string, string])[]',
  status: 'number',
};

/**
 * The type of a status, and of headers, as the guard gives them where the program makes them: what
 * `ResponseInit` takes, `undefined` among a status, and anything among a header's name and value.
 */
const GIVEN_TYPES: Readonly<Record<InitKey, string>> = {
  headers: 'readonly (readonly [unknown, unknown])[]',
  status: 'number | undefined',
};

/**
 * What the program makes of what the init gives once the body and the init are evaluated
 * (`makingOf`): the headers where one is not written as `Headers` keeps it (`keptAsWritten`), and
 * the status where the compile does not know it (`known`).
 */
function madeKeys(given: Init): readonly InitKey[] {
  const made: Readonly<Record<InitKey, boolean>> = {
    headers: given.headers.some((pair) => !keptAsWritten(pair)),
    status: given.known === undefined,
  };
  return INIT_KEYS.filter((key) => made[key]);
}

/**
 * What the program writes to make what it makes of the init (`made`), each of the expression
 * `written` names it by, as `new Response` makes it once the body and the init are evaluated: the
 * headers' names and values made text (`asTexts`), then the status made a number and checked to be
 * in range (`asStatus`) — as WebIDL converts the init's members, by their names, and Fetch checks its
 * status — then the headers made of that text (`asHeaders`), as Fetch fills a response's headers.
 * Each is held in a `const` of its name once made (`status`, `headers`), and thrown for as
 * `new Response` throws.
 */
function makingOf(
  made: readonly InitKey[],
  written: Readonly<Record<InitKey, string>>,
  named: Named,
): string {
  const headers = made.includes('headers');
  return [
    headers ? `const texts = ${asTexts(named)}(${written.headers}); ` : '',
    made.includes('status') ? `const status = ${asStatus(named)}(${written.status}); ` : '',
    headers ? `const headers = ${asHeaders(named)}(texts); ` : '',
  ].join('');
}

/**
 * The type of a descriptor as the guard gives it, where the program makes `made` of it: each of
 * those as `ResponseInit` takes it (`GIVEN_TYPES`), and the rest as a descriptor holds it.
 */
function givenType(made: readonly InitKey[]): string {
  const members = INIT_KEYS.map(
    (key) => `readonly ${key}: ${(made.includes(key) ? GIVEN_TYPES : INIT_TYPES)[key]}`,
  );
  return `{ readonly body: string; ${members.join('; ')} }`;
}

/** Where the program reads what it makes a descriptor's members of: the descriptor the guard gives. */
const ANSWERED: Readonly<Record<InitKey, string>> = {
  headers: 'answer.headers',
  status: 'answer.status',
};

/**
 * A descriptor as `new Response` makes what its init gives once the body and the init are
 * evaluated (`makingOf`): its headers made by `Headers` where one is not written as `Headers` keeps
 * it, and its status made as `new Response` makes it where the compile does not know it (`known`),
 * each thrown for as it throws; as it is where neither is made.
 */
function madeOf(descriptor: string, given: Init, named: Named): string {
  const made = madeKeys(given);
  const making = makingOf(made, ANSWERED, named);
  return made.length === 0
    ? descriptor
    : `((answer: ${givenType(made)}) => { ${making}return { ...answer, ${made.join(', ')} }; })(${descriptor})`;
}

/** The statuses of no body: No Content, Reset Content and Not Modified. */
const HTTP_NO_CONTENT = 204;
const HTTP_RESET_CONTENT = 205;
const HTTP_NOT_MODIFIED = 304;

/**
 * The statuses a response has no body of, which `new Response` throws for where it is given one —
 * an empty text too — rather than answering the status without it.
 */
const BODILESS: ReadonlySet<number> = new Set([
  HTTP_NO_CONTENT,
  HTTP_NOT_MODIFIED,
  HTTP_RESET_CONTENT,
]);

const BODILESS_TEXT =
  "A guard's response of a status that has no body — 204, 205 or 304 — holds none: `new Response(null, { status: 204 })`. `new Response` throws for text, an empty one too, where the status has no body.";

/** What the program throws where a guard's response of text has a status of no body. */
const BODILESS_THROWN = 'A response of a status that has no body is given text.';

/** What the program throws where a body the guard computes is neither text nor none. */
const NOT_TEXT_THROWN = "A guard's response is given a body that is neither text nor none.";

/** The header a response of text is given where it names no content type: `new Response(text)`'s. */
const TEXT_TYPE_PAIR = `[${literal(CONTENT_TYPE)}, ${literal(TEXT_TYPE)}]`;

/** `expression` without the parentheses around it. */
function unwrapped(expression: Expression): Expression {
  let inner = expression;
  while (isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  return inner;
}

/** Whether `value` is a sum (`a + b`): text where either side is, whatever the other holds. */
function isSum(value: Expression): value is BinaryExpression {
  return isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.PlusToken;
}

/** Whether a body is text whatever it holds, as its syntax says: a string, a template, a sum of one. */
function isText(body: Expression): boolean {
  const value = unwrapped(body);
  return (
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value) ||
    (isSum(value) && (isText(value.left) || isText(value.right)))
  );
}

/**
 * Whether a body is a value the guard computes — a name, a member, a call, a sum of none of text —
 * which no syntax says the type of: `makeBlob()` may answer bytes. Checked as the guard runs.
 */
function isComputed(body: Expression): boolean {
  const value = unwrapped(body);
  return (
    isIdentifier(value) ||
    isPropertyAccessExpression(value) ||
    isCallExpression(value) ||
    isSum(value)
  );
}

/**
 * Whether `body` is none: left out, `null` or `undefined` — the global, where the middleware
 * declares no name of its own `undefined` (`local`), which would be a value it computes.
 */
function isNone(body: Expression | undefined, local: (name: string) => boolean): boolean {
  if (body === undefined) {
    return true;
  }
  const value = unwrapped(body);
  return (
    value.kind === SyntaxKind.NullKeyword ||
    (isIdentifier(value) && value.text === 'undefined' && !local('undefined'))
  );
}

/** A property's name, as the headers list it. */
function headerName(name: Node, fail: Fail): string {
  if (isComputedPropertyName(name)) {
    return fail(HEADERS_LITERAL, name);
  }
  return isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)
    ? name.text
    : fail(HEADERS_LITERAL, name);
}

/** An element of a list of pairs, as a header: its name where it is a literal; none for no pair. */
function listedPair(element: Expression, sourceFile: SourceFile): HeaderPair | undefined {
  // A spread makes as many items at run time as its array holds, which `Headers` counts: not two
  // where the pair is written of two elements and one is a spread.
  if (
    !isArrayLiteralExpression(element) ||
    element.elements.length !== 2 ||
    element.elements.some((each) => isSpreadElement(each))
  ) {
    return undefined;
  }
  const [name, value] = element.elements;
  return {
    name: writtenText(name),
    node: name ?? element,
    text: element.getText(sourceFile),
    value: writtenText(value),
  };
}

/**
 * Whether `key`, a property's, is an array index — digits, no zero leading them, below 2³² − 1 —
 * which an object lists before its other keys, in the order of their numbers, wherever it is written.
 */
function isArrayIndex(key: string): boolean {
  return INDEX_DIGITS.test(key) && Number(key) < ARRAY_INDEX_BOUND;
}

/**
 * The headers, pair by pair. Of an object literal, each property a header of its own name, once: a
 * name written twice, which TypeScript refuses of an object literal and which the last of
 * overwrites, is refused, as is `__proto__: …`, which sets the object's prototype rather than
 * naming a header, and a name that is an array index, which `new Response` reads before the others
 * (`isArrayIndex`), whatever order the program lists them in.
 */
function headersOf(headers: Expression, sourceFile: SourceFile, fail: Fail): readonly HeaderPair[] {
  const value = unwrapped(headers);
  if (isArrayLiteralExpression(value)) {
    return value.elements.map(
      (element) => listedPair(element, sourceFile) ?? fail(HEADERS_LITERAL, value),
    );
  }
  if (!isObjectLiteralExpression(value)) {
    return fail(HEADERS_LITERAL, value);
  }
  const named = new Set<string>();
  return value.properties.map((property): HeaderPair => {
    if (isShorthandPropertyAssignment(property)) {
      // `{ __proto__ }` is a property of its own, as no `__proto__: …` is; a name twice is not.
      const name = property.name.getText(sourceFile);
      if (named.has(name)) {
        return fail(HEADERS_OWN, property);
      }
      named.add(name);
      return { name, node: property, text: `[${literal(name)}, ${name}]`, value: undefined };
    }
    if (!isPropertyAssignment(property)) {
      return fail(HEADERS_LITERAL, property);
    }
    const name = headerName(property.name, fail);
    if (name === PROTOTYPE_KEY || named.has(name)) {
      return fail(HEADERS_OWN, property);
    }
    if (isArrayIndex(name)) {
      return fail(HEADERS_INDEX, property);
    }
    named.add(name);
    const text = `[${literal(name)}, ${property.initializer.getText(sourceFile)}]`;
    return { name, node: property, text, value: writtenText(property.initializer) };
  });
}

/**
 * Whether a response of text is given the content type of text, as `new Response(text, init)` gives
 * it: where none of the headers its init names is one — each of whose names the compile reads.
 */
function typedAsText(headers: readonly HeaderPair[], fail: Fail): boolean {
  if (headers.some((pair) => pair.name?.toLowerCase() === CONTENT_TYPE)) {
    return false;
  }
  const unread = headers.find((pair) => pair.name === undefined);
  return unread === undefined ? true : fail(HEADER_NAMES, unread.node);
}

/** The headers of a response of text: those its init names, then the content type of text. */
function textHeaders(headers: readonly HeaderPair[], fail: Fail): string {
  return listOf(headers, typedAsText(headers, fail) ? [TEXT_TYPE_PAIR] : []);
}

/** What one property of a response's init gives: its status, or its headers, as written. */
function initProperty(property: Node, sourceFile: SourceFile, fail: Fail): Partial<Init> {
  if (
    isShorthandPropertyAssignment(property) &&
    isIdentifier(property.name) &&
    property.name.text === 'status'
  ) {
    return { known: undefined, status: 'status', statusNode: property.name };
  }
  if (
    !isPropertyAssignment(property) ||
    !(isIdentifier(property.name) || isStringLiteral(property.name))
  ) {
    return fail(INIT_LITERAL, property);
  }
  if (property.name.text === 'status') {
    const value = unwrapped(property.initializer);
    const known = isNumericLiteral(value) ? madeStatus(Number(value.text)) : undefined;
    return {
      known,
      status: known === undefined ? property.initializer.getText(sourceFile) : String(known),
      statusNode: property.initializer,
    };
  }
  return property.name.text === 'headers'
    ? { headers: headersOf(property.initializer, sourceFile, fail) }
    : fail(INIT_LITERAL, property);
}

/** What a response is given where its init gives nothing: a 200, and no header. */
const NO_INIT: Init = { headers: [], known: 200, status: '200', written: [] };

/**
 * The status and the headers an init gives, as written, and in which order — each once: an init
 * that gives one twice, which TypeScript refuses of an object literal, is refused, as the program
 * writes each once.
 */
function initOf(init: Expression, sourceFile: SourceFile, fail: Fail): Init {
  const value = unwrapped(init);
  if (!isObjectLiteralExpression(value)) {
    return fail(INIT_LITERAL, value);
  }
  let given = NO_INIT;
  for (const property of value.properties) {
    const read = initProperty(property, sourceFile, fail);
    const key: InitKey = read.headers === undefined ? 'status' : 'headers';
    if (given.written.includes(key)) {
      fail(
        `The response's init gives \`${key}\` twice, which TypeScript refuses of an object literal: give it once.`,
        property,
      );
    }
    given = { ...given, ...read, written: [...given.written, key] };
  }
  return given;
}

/**
 * The status and the headers of `given` in the order `new Response(body, init)` evaluates what they
 * are made of: as the init writes them, then what it leaves out, of a default that evaluates
 * nothing.
 */
function orderOf(given: Init): readonly InitKey[] {
  return [...given.written, ...INIT_KEYS.filter((key) => !given.written.includes(key))];
}

/**
 * A descriptor of `body` and of the status and the headers given, as the program writes it: in the
 * order `new Response(body, init)` evaluates what each is made of — the body, then the init's, as
 * it writes them — whatever the expressions do to one another as they are evaluated: each as
 * written, what the program makes of them made once all are (`madeOf`).
 */
function descriptorText(given: Init, values: Readonly<Record<'body' | InitKey, string>>): string {
  const properties = orderOf(given).map((key) => `${key}: ${values[key]}`);
  return `{ body: ${values.body}, ${properties.join(', ')} }`;
}

/** What tells whether `status` — an expression of the program's — is a status of no body. */
function bodilessOf(status: string): string {
  return [...BODILESS].map((code) => `${status} === ${String(code)}`).join(' || ');
}

/**
 * A descriptor of text, checked for its status as `new Response` checks it once its body and its
 * init are evaluated, its headers and its status made first (`madeOf`): refused where the compile
 * knows it to be a status that has no body (`BODILESS`), for which `new Response` throws; thrown for
 * as the guard runs where it is computed.
 */
function checkedText(descriptor: string, given: Init, writing: Writing): string {
  const { known, statusNode } = given;
  if (known !== undefined) {
    return statusNode !== undefined && BODILESS.has(known)
      ? writing.fail(BODILESS_TEXT, unwrapped(statusNode))
      : madeOf(descriptor, given, writing.named);
  }
  const thrown = `throw new ${writing.named('TypeError')}(${literal(BODILESS_THROWN)});`;
  return `((answer: ${DESCRIPTOR_TYPE}) => { if (${bodilessOf('answer.status')}) { ${thrown} } return answer; })(${madeOf(descriptor, given, writing.named)})`;
}

/**
 * What a guard's `return <expression>` answers, as the program writes it: the descriptor of the
 * `new Response(…)` it returns. `local` says whether a name is the middleware's own, which
 * `Response` — the global — is not.
 */
function descriptorOf(
  expression: Expression,
  sourceFile: SourceFile,
  context: Writing & { readonly local: (name: string) => boolean },
): string {
  const { fail, named } = context;
  const created = unwrapped(expression);
  if (
    !isNewExpression(created) ||
    !isIdentifier(created.expression) ||
    created.expression.text !== 'Response' ||
    context.local('Response')
  ) {
    return fail(RESPONSE_ONLY, expression);
  }
  const [body, init, ...more] = created.arguments ?? [];
  if (more.length > 0) {
    fail(RESPONSE_ONLY, more[0]);
  }
  checkBody(body, fail, context.local);
  const given = init === undefined ? NO_INIT : initOf(init, sourceFile, fail);
  return bodyDescriptor(body, given, { fail, local: context.local, named, sourceFile });
}

/**
 * Refuses a body that is neither text, nor none, nor a value the guard computes — which is checked
 * as it runs — on any branch of a condition it is.
 */
function checkBody(
  body: Expression | undefined,
  fail: Fail,
  local: (name: string) => boolean,
): void {
  if (body === undefined || isNone(body, local)) {
    return;
  }
  const value = unwrapped(body);
  if (isConditionalExpression(value)) {
    checkBody(value.whenTrue, fail, local);
    checkBody(value.whenFalse, fail, local);
  } else if (!isText(value) && !isComputed(value)) {
    fail(TEXT_BODY, body);
  }
}

/**
 * What a response of a body the guard computes answers where the body is text, as the program
 * writes it: the descriptor of text, its status checked as `checkedText` checks it; or, where the
 * compile knows the status to be one that has no body, the throw `new Response` would make.
 */
function computedText(given: Init, writing: Writing): string {
  const { known } = given;
  const thrown = `throw new ${writing.named('TypeError')}(${literal(BODILESS_THROWN)});`;
  if (known !== undefined && BODILESS.has(known)) {
    return thrown;
  }
  const checked = known === undefined ? `if (${bodilessOf('status')}) { ${thrown} } ` : '';
  const headers = typedAsText(given.headers, writing.fail)
    ? `[...headers, ${TEXT_TYPE_PAIR} as const]`
    : 'headers';
  return `${checked}return { body, status, headers: ${headers} };`;
}

/**
 * What the descriptor of a body the guard computes names the headers and the status it is handed as
 * written, where the program makes them (`madeKeys`): each made of it under its own name
 * (`makingOf`).
 */
const WRITTEN_NAMES: Readonly<Record<InitKey, string>> = { headers: 'listed', status: 'written' };

/**
 * The parameter the descriptor of a body the guard computes takes `key` of the init by: as written,
 * where the program makes it (`made`), and otherwise as a descriptor holds it.
 */
function parameterOf(key: InitKey, made: readonly InitKey[]): string {
  return made.includes(key)
    ? `${WRITTEN_NAMES[key]}: ${GIVEN_TYPES[key]}`
    : `${key}: ${INIT_TYPES[key]}`;
}

/**
 * The descriptor of a response of a body the guard computes, as the program writes it: told apart as
 * the guard runs — of text where the value is text, of no body where it is none (`null`,
 * `undefined`), as `new Response` takes each — and thrown for where it is anything else, which no
 * descriptor carries (a `Blob`, bytes), as a computed status of no body is for text (`checkedText`).
 * The body, the status and the headers are handed to it as written, in the order `new Response`
 * evaluates them (`orderOf`), and what the program makes of them is made first, as `new Response`
 * makes it (`makingOf`): headers it does not write as `Headers` keeps them, and a status the guard
 * computes.
 */
function computedDescriptor(
  body: Expression,
  given: Init,
  context: Writing & { readonly sourceFile: SourceFile },
): string {
  const { named, sourceFile } = context;
  const values: Readonly<Record<InitKey, string>> = {
    headers: listOf(given.headers),
    status: given.status,
  };
  const made = madeKeys(given);
  const order = orderOf(given);
  const parameters = ['body: unknown', ...order.map((key) => parameterOf(key, made))];
  const handed = [body.getText(sourceFile), ...order.map((key) => values[key])];
  const making = makingOf(made, WRITTEN_NAMES, named);
  const text = `if (typeof body === 'string') { ${computedText(given, context)} }`;
  const none = "if (body === null || body === undefined) { return { body: '', status, headers }; }";
  const thrown = `throw new ${named('TypeError')}(${literal(NOT_TEXT_THROWN)});`;
  return `((${parameters.join(', ')}) => { ${making}${text} ${none} ${thrown} })(${handed.join(', ')})`;
}

/**
 * The descriptor of a response of `body` and of what its init gives, as the program writes it. No
 * body is written as an empty one, as a descriptor's body is text: the content type tells the two
 * apart, which `new Response('')` gives an empty text and `new Response(null)` nothing — and a
 * status of no body, which `new Response` refuses an empty text for, as it refuses any other. A
 * body that is a condition (`ok ? 'Gone' : null`) is written as the condition between the
 * descriptors of its branches, each its own: one of no body answered without the type of text.
 */
function bodyDescriptor(
  body: Expression | undefined,
  given: Init,
  context: Writing & {
    readonly sourceFile: SourceFile;
    readonly local: (name: string) => boolean;
  },
): string {
  const { local, named, sourceFile } = context;
  if (body === undefined || isNone(body, local)) {
    const descriptor = descriptorText(given, {
      body: "''",
      headers: listOf(given.headers),
      status: given.status,
    });
    return madeOf(descriptor, given, named);
  }
  const value = unwrapped(body);
  if (isConditionalExpression(value)) {
    const whenTrue = bodyDescriptor(value.whenTrue, given, context);
    const whenFalse = bodyDescriptor(value.whenFalse, given, context);
    return `(${value.condition.getText(sourceFile)} ? ${whenTrue} : ${whenFalse})`;
  }
  if (!isText(value)) {
    return computedDescriptor(body, given, context);
  }
  const descriptor = descriptorText(given, {
    body: body.getText(sourceFile),
    headers: textHeaders(given.headers, context.fail),
    status: given.status,
  });
  return checkedText(descriptor, given, context);
}

/** Whether `node` is a function or a class, whose `return`s are its own. */
function ownsReturns(node: Node): boolean {
  return (
    isFunctionLike(node) ||
    node.kind === SyntaxKind.ClassExpression ||
    node.kind === SyntaxKind.ClassDeclaration
  );
}

/** What the program writes of a guard's answers (`guardAnswers`). */
export interface GuardAnswers {
  /** What it writes in place of each `return` of a response: its descriptor, by the expression. */
  readonly answers: ReadonlyMap<Node, string>;
  /**
   * The platform's globals it writes by a name of its own, where the middleware declares one of
   * theirs (`globalNames`): that name, by the global's, which the program binds the global to.
   */
  readonly globals: ReadonlyMap<string, string>;
}

/**
 * Each `return` of `statements`, a guard — outside the functions they hold — by its expression,
 * with what the program writes in its place: the descriptor of the response it returns, made by the
 * platform's globals whatever the middleware declares of their names (`globalNames`).
 */
export function guardAnswers(
  statements: readonly Statement[],
  sourceFile: SourceFile,
  context: { readonly fail: Fail; readonly local: (name: string) => boolean },
): GuardAnswers {
  const answers = new Map<Node, string>();
  const { globals, named } = globalNames(context.local);
  const writing = { ...context, named };
  const visit = (node: Node): void => {
    if (ownsReturns(node)) {
      return;
    }
    if (isReturnStatement(node)) {
      const { expression } = node;
      if (expression === undefined) {
        return context.fail(RESPONSE_ONLY, node);
      }
      answers.set(expression, descriptorOf(expression, sourceFile, writing));
      return;
    }
    node.forEachChild(visit);
  };
  for (const statement of statements) {
    visit(statement);
  }
  return { answers, globals };
}
