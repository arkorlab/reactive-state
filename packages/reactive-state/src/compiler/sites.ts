import {
  type ArrowFunction,
  type CallExpression,
  type Expression,
  type Identifier,
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isBinaryExpression,
  isBitwiseOperatorOrHigher,
  isCallExpression,
  isConditionalExpression,
  isDeleteExpression,
  isFunctionExpression,
  isIdentifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isJsxText,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isTypeOfExpression,
  isVoidExpression,
  isYieldExpression,
  type Node,
  type ReturnStatement,
  SyntaxKind,
} from 'typescript/ast';

import { impureGlobal } from './alike.ts';
import { RESERVED, type TopLevel } from './analyze.ts';
import { chained, checkComputed } from './computed.ts';
import type { Derivation } from './derive.ts';
import { jsxTextChild } from './entities.ts';
import { KEY_READS, refusedInCondition, unsettledRefusal } from './following.ts';
import { inDeclarationOrder, type SiteInput } from './frames.ts';
import { checkSiteValue } from './json-values.ts';
import { isJsx } from './jsx.ts';
import { checkKeyType } from './key-types.ts';
import { authorityVisitor, entryOf, type SideState } from './reads.ts';
import type { Visitor } from './scope.ts';
import { attributeValues, checkKey, keyOf, listMisuseOf, type ReactiveElement } from './slots.ts';

/**
 * The reactive components a component with state renders with values of its local states —
 * `<TodoResults filter={filter} />`, or one a condition of the browser's stands over,
 * `{open && <TodoDetails … />}` — which no slot can hold (`slots.ts`): each is a dynamic site of the
 * client part. The authority's program renders its element of the states the element reads
 * (`render`), and says whether the page shows it while every state holds its first value, of the
 * conditions it stands under (`guard`); the Client Component shows what the authority rendered there
 * for the values it holds now (`sites.of("d0", { filter })`), under its conditions as it wrote them,
 * and the page asks the authority for the site again as they change. What the element reads, the
 * authority has: the local states, each started from a value the authority evaluates (`sides.ts`),
 * and what the browser computes of them — a constant, an item a custom hook returns — which the
 * authority computes again of them (`derive.ts`); the props, what the server part computes, the
 * globals of what they are given alone and the application's shared modules.
 *
 * One rendered in the callback of a keyed `.map()` is a list site: `panels.map((panel) =>
 * <PanelCard key={panel.panelId}>…<TodoDetails id={panel.todoId} /></PanelCard>)`. The authority's
 * program maps what the browser maps, of the states it is computed of, to each item's key, the item,
 * and its element (`each`); the Client Component keeps its `.map()`, and shows each item's rendering
 * (`sites.item("d1", { panels }, { item: panel, key: panel.panelId })`). The page holds each item's
 * rendering by its key and the item alone, so the element is rendered of the item, and of nothing
 * else of the browser's; the key, which both sides compute, of the item, the props and what any
 * side has.
 */

/** How a condition holds where a site shows: true, false, or `null` or `undefined`. */
type Holds = 'falsy' | 'nullish' | 'truthy';

/** How a site's condition holds where the site shows, by the operator it is the left of. */
const RIGHT_OF: ReadonlyMap<SyntaxKind, Holds> = new Map([
  [SyntaxKind.AmpersandAmpersandToken, 'truthy'],
  [SyntaxKind.BarBarToken, 'falsy'],
  [SyntaxKind.QuestionQuestionToken, 'nullish'],
]);

/** A keyed `.map()`, as what a refusal of a list says it writes. */
const KEYED_MAP = '`items.map((item) => <Card key={item.id}>…</Card>)`';

/** The callback of a keyed `.map()`, as what a refusal of a list says it writes. */
const KEYED_CALLBACK = '`(item) => <Card key={item.id}>…</Card>`';

/** A condition a site stands under, and how it holds where the site shows. */
export interface Condition {
  readonly test: Expression;
  readonly holds: Holds;
}

/** A site the browser renders for each item of an array, in the callback of a keyed `.map()`. */
export interface SiteList {
  /** The `.map()` call. */
  readonly call: CallExpression;
  /** What is mapped: `panels` of `panels.map(…)`. */
  readonly array: Expression;
  /** The callback's parameter: each item, as the callback names it. */
  readonly item: Identifier;
  /** The key of the element the callback returns, of the item: `panel.panelId`. */
  readonly key: Expression;
}

export interface Site {
  /** `d0`, `d1`…, in the order the sites stand in the JSX. */
  readonly name: string;
  /** The element of the reactive component the authority renders there. */
  readonly element: ReactiveElement;
  /** Whether it stands as a child of JSX, which the Client Component writes in braces. */
  readonly child: boolean;
  /** The conditions it stands under, outermost first. */
  readonly conditions: readonly Condition[];
  /**
   * The local states its element is rendered of — what its props and its key read, and what the
   * browser computes of what they read — in the order they are declared.
   */
  readonly inputs: readonly SiteInput[];
  /** The states its conditions are computed of, in the order they read them first. */
  readonly guarded: readonly SiteInput[];
  /**
   * What the page sends for it, in the order the states are declared: what its element reads, and
   * what its conditions read, which the authority checks the conditions with again — of the props
   * and what the server part computes now — before it renders the site for a view, or replays it.
   */
  readonly sent: readonly SiteInput[];
  /** For a list site, the list: its element rendered for each item of an array. */
  readonly list?: SiteList;
}

/** What the sites are read with. */
export interface SiteReading {
  readonly state: SideState;
  readonly returned: ReturnStatement;
  readonly walking: (node: Node, visitor: Visitor, outer?: ReadonlySet<string>) => void;
  readonly derivation: Derivation;
}

/** The sites of `elements`, the reactive elements no slot holds, each refused where it cannot be one. */
export function readSites(
  elements: readonly ReactiveElement[],
  reading: SiteReading,
): readonly Site[] {
  return elements.map((element, index) => siteOf(element, `d${String(index)}`, reading));
}

function siteOf(element: ReactiveElement, name: string, reading: SiteReading): Site {
  const { derivation, returned, state, walking } = reading;
  const list = listOf(element, returned, state);
  checkShape(element, state);
  const conditions = conditionsOf(list?.call ?? element, returned, { element, state });
  const inputs = new Map<string, SiteInput>();
  // What the authority computes of the inputs — a list's array and its key, a condition, what the
  // element is given — is held to the grammar of what both sides compute alike (`computed.ts`): it
  // computes it again of what a view sends, and of what a binding issued inside it names.
  const alike = (node: Node): void => {
    checkComputed(node, (message) => state.fail(message, node));
  };
  for (const value of attributeValues(element)) {
    alike(value);
  }
  if (list === undefined) {
    walking(element, elementVisitor(state, { derivation, inputs }));
  } else {
    // The array is the browser's, followed into the states it is computed of; the key and the
    // element, the item's alone, beside what the authority has.
    alike(list.array);
    walking(list.array, elementVisitor(state, { derivation, inputs }));
    derivation.inSite(list.item);
    const outer = new Set([list.item.text]);
    alike(list.key);
    checkKey(list.key, state.fail);
    checkKeyType(list, state);
    walking(list.key, itemVisitor(state, { derivation, item: list.item, part: 'key' }), outer);
    walking(element, itemVisitor(state, { derivation, item: list.item, part: 'element' }), outer);
  }
  // What the element is given is JSON where the code shows it, once what it reads is followed.
  for (const value of attributeValues(element)) {
    checkSiteValue(state, value);
  }
  const guarded = new Map<string, SiteInput>();
  for (const condition of conditions) {
    alike(condition.test);
    walking(condition.test, conditionVisitor(state, { derivation, inputs: guarded }));
  }
  const sent = new Map(inputs);
  for (const [key, input] of guarded) {
    if (!sent.has(key)) {
      sent.set(key, input);
    }
  }
  return {
    child: isJsxElement(element.parent) || isJsxFragment(element.parent),
    conditions,
    element,
    guarded: [...guarded.values()],
    inputs: inDeclarationOrder([...inputs.values()]),
    ...(list !== undefined && { list }),
    name,
    sent: inDeclarationOrder([...sent.values()]),
  };
}

/** The name of the reactive component an element renders, as its tag names it. */
function tagOf(element: ReactiveElement): string {
  const tag = isJsxElement(element) ? element.openingElement.tagName : element.tagName;
  return isIdentifier(tag) ? tag.text : '';
}

/** Why a site's element is refused in a function: what the authority renders a site in. */
function inFunction(tag: string): string {
  return `\`${tag}\` is rendered with values of the browser's — a local state its props read, or a condition the browser decides — so the authority renders it at a dynamic site: once where it stands in the JSX the component returns, or once for each item of a keyed \`.map()\` — ${KEYED_MAP}, whose callback takes the item alone and returns the element it keys — and in no other function of the browser's, which a handler is, or a list within a list. Render it outside the function, or render it in a reactive component of its own, given what it renders as a prop.`;
}

/**
 * The list a site's element is rendered in, where it stands in a function: the callback of a keyed
 * `.map()`, its one parameter the item, its body the element it keys — the site's element, or one
 * it stands in, under no condition of the callback's own. Any other function is refused.
 */
function listOf(
  element: ReactiveElement,
  returned: ReturnStatement,
  state: SideState,
): SiteList | undefined {
  const tag = tagOf(element);
  let callback: ArrowFunction | undefined;
  for (let node: Node = element.parent; node !== returned; node = node.parent) {
    if (isArrowFunction(node) || isFunctionExpression(node)) {
      if (callback !== undefined || !isArrowFunction(node)) {
        state.fail(inFunction(tag), element);
      }
      callback = node;
    }
  }
  if (callback === undefined) {
    return undefined;
  }
  const list = keyedMap(callback, tag, state);
  for (let node: Node = element.parent; node !== callback; node = node.parent) {
    if (
      isConditionalExpression(node) ||
      (isBinaryExpression(node) && RIGHT_OF.has(node.operatorToken.kind))
    ) {
      state.fail(
        `\`${tag}\` stands under a condition within the callback of the \`.map()\` it is listed by: the page holds each item's rendering by its key and the item, and the authority renders one for each item. Leave the item out of the array instead, or decide the condition in the reactive component, of the item.`,
        node,
      );
    }
  }
  return list;
}

/** The keyed `.map()` `callback` is the callback of; refused where it is no such callback. */
function keyedMap(callback: ArrowFunction, tag: string, state: SideState): SiteList {
  const call = callback.parent;
  if (
    !isCallExpression(call) ||
    call.arguments.length !== 1 ||
    !isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'map'
  ) {
    return state.fail(inFunction(tag), callback);
  }
  const misuse = listMisuseOf(call);
  if (misuse !== undefined) {
    return state.fail(
      `The \`.map()\` \`${tag}\` is listed by is used otherwise than as it is — \`.slice(…)\`, \`.filter(…)\` after it — where the authority renders an item for each of the array it maps, the items the browser leaves out too: choose the items before the \`.map()\`, \`items.slice(0, 1).map(…)\`.`,
      misuse,
    );
  }
  if (chained(call)) {
    return state.fail(
      `The array \`${tag}\` is listed by is mapped in an optional chain — \`items?.map(…)\`, \`a?.items.map(…)\` — which maps nothing where the chain stops, and the authority renders an item for each of an array. Map an array: \`(a?.items ?? []).map(…)\`.`,
      call,
    );
  }
  if (callback.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true) {
    return state.fail(
      `The callback of the \`.map()\` \`${tag}\` is listed by is async: it answers a promise for each item, where the authority renders the element it returns. Return the element itself.`,
      callback,
    );
  }
  const [parameter, ...more] = callback.parameters;
  if (
    parameter === undefined ||
    more.length > 0 ||
    !isIdentifier(parameter.name) ||
    parameter.initializer !== undefined ||
    parameter.dotDotDotToken !== undefined
  ) {
    return state.fail(
      `The callback of the \`.map()\` \`${tag}\` is listed by takes the item alone, by name — \`(item) => …\` — no index, no pattern: the authority hands it each item as the browser does, and the page holds each item's rendering by the item.`,
      callback,
    );
  }
  if (RESERVED.has(parameter.name.text)) {
    return state.fail(
      `The callback of the \`.map()\` \`${tag}\` is listed by names the item \`${parameter.name.text}\`, a name the compile's outputs read where the item shows. Give the item another name.`,
      parameter.name,
    );
  }
  let body: Node = callback.body;
  while (isParenthesizedExpression(body)) {
    body = body.expression;
  }
  const key = isJsxElement(body) || isJsxSelfClosingElement(body) ? keyOf(body) : undefined;
  if (key === undefined) {
    return state.fail(
      `The callback of the \`.map()\` \`${tag}\` is listed by returns the element it keys, as its expression — ${KEYED_CALLBACK} — which the page holds each item's rendering by.`,
      callback.body,
    );
  }
  return { array: call.expression.expression, call, item: parameter.name, key };
}

/**
 * Refuses a site's element where the authority could not render it again of the states it reads:
 * with children, or with a spread of props.
 */
function checkShape(element: ReactiveElement, state: SideState): void {
  const tag = tagOf(element);
  const attributes = (isJsxElement(element) ? element.openingElement : element).attributes
    .properties;
  const held = heldOf(element) ?? attributes.find((attribute) => isChildrenAttribute(attribute));
  if (held !== undefined) {
    state.fail(
      `\`${tag}\` is rendered at a dynamic site, which the authority renders again of the local states it reads whenever they change, and takes its props alone: what it holds between its tags, or as a \`children\` attribute, is JSX of the browser's, which the authority does not render. Give it what it needs as props, and render the rest beside it.`,
      held,
    );
  }
  const spread = attributes.find((attribute) => isJsxSpreadAttribute(attribute));
  if (spread !== undefined) {
    state.fail(
      `\`${tag}\` is rendered at a dynamic site, of the local states its props read, which the compiler reads prop by prop: a spread hides them. Write each prop out.`,
      spread,
    );
  }
}

/**
 * The first of what an element holds between its tags that renders anything: neither white space
 * alone, which JSX drops, nor a comment.
 */
function heldOf(element: ReactiveElement): Node | undefined {
  if (!isJsxElement(element)) {
    return undefined;
  }
  return element.children.find((child) => {
    if (isJsxText(child)) {
      return jsxTextChild(child.text) !== undefined;
    }
    return !isJsxExpression(child) || child.expression !== undefined;
  });
}

/** Whether an attribute gives its element children: `children={…}`. */
function isChildrenAttribute(attribute: Node): boolean {
  return (
    isJsxAttribute(attribute) && isIdentifier(attribute.name) && attribute.name.text === 'children'
  );
}

/**
 * The conditions a site stands under, from its element — or the `.map()` of its list — out to the
 * JSX the component returns, across the elements it is in, outermost first: the test of a `?:` it
 * is a branch of, the left of `&&`, `||` and `??` it is the right of. The left of `||` and `??`
 * shows whatever the right holds; the left of `&&`, and the test of a `?:`, show nothing of
 * themselves, and are refused for a site.
 */
function conditionsOf(
  from: Node,
  returned: ReturnStatement,
  { element, state }: { readonly element: ReactiveElement; readonly state: SideState },
): readonly Condition[] {
  const found: Condition[] = [];
  const tested = (): never => {
    return state.fail(
      `\`${tagOf(element)}\` is used as a condition — the test of a \`?:\`, or the left of \`&&\` — which decides what shows rather than showing what it renders, and an element is always true. Render it where it shows, and test the values it is rendered with.`,
      from,
    );
  };
  let child: Node = from;
  for (let node: Node = from.parent; node !== returned; node = node.parent) {
    const condition = conditionAt(node, child, tested);
    if (condition !== undefined) {
      found.push(condition);
    }
    child = node;
  }
  const conditions = found.toReversed();
  for (const condition of conditions) {
    const jsx = jsxIn(condition.test);
    if (jsx !== undefined) {
      state.fail(
        `A condition a dynamic site stands under is evaluated by the authority as well as by the browser, for the page's first render, and holds no JSX, which is always true and renders nothing there. Test the values it is rendered with.`,
        jsx,
      );
    }
  }
  return conditions;
}

/**
 * The condition `node` decides whether its operand `child` shows by, and how it holds where it
 * does; none where `node` decides nothing of it. Where `child` is the condition itself, `tested`.
 */
function conditionAt(node: Node, child: Node, tested: () => never): Condition | undefined {
  if (isConditionalExpression(node)) {
    if (child === node.condition) {
      return tested();
    }
    return { holds: child === node.whenTrue ? 'truthy' : 'falsy', test: node.condition };
  }
  if (!isBinaryExpression(node)) {
    return undefined;
  }
  const holds = RIGHT_OF.get(node.operatorToken.kind);
  if (holds !== undefined && child === node.right) {
    return { holds, test: node.left };
  }
  return node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken ? tested() : undefined;
}

/** The first JSX within `node`, if it holds any. */
function jsxIn(node: Node): Node | undefined {
  if (isJsx(node)) {
    return node;
  }
  let found: Node | undefined;
  node.forEachChild((child) => {
    found ??= jsxIn(child);
  });
  return found;
}

/** What a site's element and its conditions are read with: their states, followed as they are computed. */
interface Inputs {
  readonly derivation: Derivation;
  readonly inputs: Map<string, SiteInput>;
}

/** What a list's key and its element are read with: the item, and which part of the list each is. */
interface Item {
  readonly derivation: Derivation;
  readonly item: Identifier;
  readonly part: 'element' | 'key';
}

/** The names of a component's whose values the browser holds alone. */
const BROWSER_KINDS: ReadonlySet<TopLevel['kind']> = new Set([
  'constant',
  'hooked',
  'node',
  'setter',
  'state',
]);

/**
 * The visitor of a list's key, or of its element, which the authority renders for each item: what
 * they read of the component's, which is nothing of the browser's — the page holds each item's
 * rendering by its key and the item — and, for the key, which the browser computes too, nothing
 * of the server part's.
 */
function itemVisitor(state: SideState, reading: Item): Visitor {
  const authority = siteVisitor(state, reading.derivation);
  const { item, part } = reading;
  return {
    ...authority,
    read: (identifier, space) => {
      const entry = entryOf(state, identifier);
      if (space === 'value' && BROWSER_KINDS.has(entry.kind)) {
        state.fail(
          `\`${identifier.text}\` is the browser's, and the ${part} of a list's item is computed of the item — \`${item.text}\` — beside the props, the globals of what they are given alone and the application's shared modules${part === 'key' ? '' : ', and what the server part computes'}: the page holds each item's rendering by its key and the item, whatever else of the browser's changes. Read it of the item, or render it beside the list.`,
          identifier,
        );
      }
      if (part === 'key' && space === 'value') {
        const refused = refusedInCondition(identifier.text, entry, KEY_READS);
        if (refused !== undefined) {
          state.fail(refused, identifier);
        }
      } else if (space === 'value') {
        checkSettled(state, identifier, entry);
      }
      authority.read(identifier, space);
    },
  };
}

/**
 * The visitor of a site's element, which the authority renders, or of a list's array: what any JSX
 * it renders reads, and the local states it is rendered of, each an input of the site's — read as
 * they are, or through what the browser computes of them (`derive.ts`).
 */
function elementVisitor(state: SideState, reading: Inputs): Visitor {
  const authority = siteVisitor(state, reading.derivation);
  return {
    ...authority,
    read: (identifier, space, scope) => {
      if (space === 'type') {
        authority.read(identifier, space);
        return;
      }
      const entry = entryOf(state, identifier);
      if (!reading.derivation.read(identifier, entry, { inputs: reading.inputs, scope })) {
        checkSettled(state, identifier, entry);
        authority.read(identifier, space);
      }
    },
  };
}

/**
 * Refuses `identifier`, read in what a site is computed of, where it is of a shared module that
 * answers otherwise each time, or on each side, it runs (`ModuleClass.unsettled`): the authority
 * computes the site again each time a view asks, of what it is sent.
 */
function checkSettled(state: SideState, identifier: Identifier, entry: TopLevel): void {
  const refused = unsettledRefusal(identifier.text, entry);
  if (refused !== undefined) {
    state.fail(refused, identifier);
  }
}

/**
 * The visitor of a condition a site stands under, which the authority evaluates for the page's first
 * render as well as the browser does: the states it is computed of, each the guard's to read.
 */
function conditionVisitor(state: SideState, reading: Inputs): Visitor {
  const authority = siteVisitor(state, reading.derivation);
  return {
    ...authority,
    read: (identifier, space, scope) => {
      if (space === 'type') {
        authority.read(identifier, space);
        return;
      }
      const entry = entryOf(state, identifier);
      const refused = refusedInCondition(identifier.text, entry);
      if (refused !== undefined) {
        state.fail(refused, identifier);
      }
      if (!reading.derivation.read(identifier, entry, { inputs: reading.inputs, scope })) {
        authority.read(identifier, space);
      }
    },
  };
}

/**
 * What the authority makes of a site's own code, which its program writes as it is: what it reads
 * and holds, and the names it declares or reads as globals, which the code written in place within
 * it is kept apart from (`derive.ts`). A global it reads is one of what it is given alone: the
 * authority computes the code again of the inputs — those a view sends, those a binding issued
 * inside it names — as the browser computes what it computes too.
 */
function siteVisitor(state: SideState, derivation: Derivation): Visitor {
  const authority = authorityVisitor(state, true);
  return {
    ...authority,
    declare: (identifier) => {
      derivation.inSite(identifier);
    },
    global: (identifier) => {
      const impure = impureGlobal(identifier.text);
      if (impure !== undefined) {
        state.fail(impure, identifier);
      }
      authority.global?.(identifier);
      derivation.inSite(identifier);
    },
  };
}

/** How tightly an expression holds together: what binds it loosest, from `?:` and `||` up. */
const LOOSE = 0;
/** `&&`. */
const CONJUNCTION = 1;
/** A bitwise, equality, relational or arithmetic operator, `as` and `satisfies`. */
const OPERATOR = 2;
/** `!x`, `typeof x`, `void x`, `delete x`, `await x`. */
const UNARY = 3;
/** A name, a literal, a call, an access, parentheses: what no operator holds together. */
const OPERAND = 4;

function bindingOf(expression: Expression): number {
  if (isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (operator === SyntaxKind.AmpersandAmpersandToken) {
      return CONJUNCTION;
    }
    return isBitwiseOperatorOrHigher(operator) ? OPERATOR : LOOSE;
  }
  if (isAsExpression(expression) || isSatisfiesExpression(expression)) {
    return OPERATOR;
  }
  if (
    isPrefixUnaryExpression(expression) ||
    isTypeOfExpression(expression) ||
    isVoidExpression(expression) ||
    isDeleteExpression(expression) ||
    isAwaitExpression(expression)
  ) {
    return UNARY;
  }
  if (
    isConditionalExpression(expression) ||
    isArrowFunction(expression) ||
    isYieldExpression(expression)
  ) {
    return LOOSE;
  }
  return OPERAND;
}

/**
 * `text`, the text of `expression`, as the operand of a unary operator or of a cast: in parentheses
 * where an operator other than a unary one holds it together.
 */
export function operand(expression: Expression, text: string): string {
  return bindingOf(expression) >= UNARY ? text : `(${text})`;
}

/** `text`, the text of `expression`, as what a method is called on: in parentheses where any operator holds it together. */
export function accessed(expression: Expression, text: string): string {
  return bindingOf(expression) === OPERAND ? text : `(${text})`;
}

/** A condition as a guard joins it: its text, and how tightly it holds together. */
interface Term {
  readonly written: string;
  readonly binding: number;
}

/** A condition written as it holds where a site shows — `c`, `!c`, `c == null` — of its own text. */
const TERMS: Readonly<Record<Holds, (test: Expression, written: string) => Term>> = {
  falsy: (test, written) => ({ binding: UNARY, written: `!${operand(test, written)}` }),
  nullish: (test, written) => ({ binding: OPERATOR, written: `${operand(test, written)} == null` }),
  truthy: (test, written) => ({ binding: bindingOf(test), written }),
};

/**
 * The guard of a site's conditions, as the authority's program writes it: each, outermost first, as
 * it holds where the site shows — `c`, `!c`, `c == null` — joined by `&&`, and in parentheses where
 * the join would hold it together otherwise. `text` writes a condition's own expression.
 */
export function guardOf(
  conditions: readonly Condition[],
  text: (test: Expression) => string,
): string {
  const terms = conditions.map(({ holds, test }) => TERMS[holds](test, text(test)));
  const joined =
    terms.length === 1
      ? (terms[0]?.written ?? '')
      : terms
          .map(({ binding, written }) => (binding < CONJUNCTION ? `(${written})` : written))
          .join(' && ');
  // An arrow's body that opens with a brace is a block, not an object.
  return joined.startsWith('{') ? `(${joined})` : joined;
}
