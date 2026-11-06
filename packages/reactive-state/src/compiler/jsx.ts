import {
  type Expression,
  isIdentifier,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxNamespacedName,
  isJsxSelfClosingElement,
  isJsxSpreadAttribute,
  isJsxText,
  isStringLiteral,
  type JsxAttributeName,
  type JsxAttributes,
  type JsxChild,
  type JsxElement,
  type JsxFragment,
  type JsxSelfClosingElement,
  type JsxTagNameExpression,
  type Node,
  type SourceFile,
} from 'typescript/ast';

import { jsxAttributeString, jsxTextChild } from './entities.ts';
import type { Fail } from './errors.ts';
import { indentAt, literal, propertyName, reindented } from './splice.ts';

/**
 * JSX the authority renders, as its program writes it: `$.h(type, props, ...children)`, React's
 * classic transform — the props an object, `key` among them, each attribute's string decoded, a
 * boolean attribute `true`, a spread spread; the children each an argument, the JSX text between
 * them as React's transform makes it a string; a fragment `$.fragment`. What renders it builds data
 * of it, not React's elements.
 */

export type Jsx = JsxElement | JsxFragment | JsxSelfClosingElement;

/** Whether `node` is JSX: an element, or a fragment. */
export function isJsx(node: Node): node is Jsx {
  return isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node);
}

/** What JSX is rendered with. */
export interface Rendering {
  readonly sourceFile: SourceFile;
  readonly fail: Fail;
  /** The text of an expression within JSX, its own JSX rendered too. */
  readonly expression: (node: Expression) => string;
  /** How the element type a tag names is written: `"main"`, `TodoRow`. */
  readonly type: (tag: JsxTagNameExpression) => string;
}

/** The widest a call is written on one line, past which its children go one to a line. */
const WIDTH = 100;

/** A piece of text written into a call, with the indent its lines after the first were written from. */
interface Piece {
  readonly text: string;
  readonly from: string;
}

/**
 * `$.h(…)` of `node`, its lines after the first indented from the indent of the line `node` starts
 * on, as the text around it is.
 */
export function rendered(node: Jsx, rendering: Rendering): string {
  const { sourceFile } = rendering;
  const indent = indentAt(sourceFile.text, node.getStart(sourceFile));
  if (isJsxFragment(node)) {
    return call(indent, [plain('$.fragment'), plain('null')], childrenOf(node.children, rendering));
  }
  const opening = isJsxElement(node) ? node.openingElement : node;
  const children = isJsxElement(node) ? childrenOf(node.children, rendering) : [];
  return call(
    indent,
    [plain(rendering.type(opening.tagName)), propsOf(opening.attributes, rendering)],
    children,
  );
}

function plain(text: string): Piece {
  return { from: '', text };
}

function pieceOf(node: Node, text: string, rendering: Rendering): Piece {
  return { from: indentAt(rendering.sourceFile.text, node.getStart(rendering.sourceFile)), text };
}

/**
 * `$.h(type, props, …children)`: on one line where it is short, or has no child, and otherwise with
 * its children one to a line.
 */
function call(indent: string, head: readonly [Piece, Piece], children: readonly Piece[]): string {
  const flat = `$.h(${[...head, ...children].map((piece) => piece.text).join(', ')})`;
  if (children.length === 0 || (!flat.includes('\n') && indent.length + flat.length <= WIDTH)) {
    return flat;
  }
  const inner = `${indent}  `;
  return [
    `$.h(${head.map((piece) => reindented(piece.text, piece.from, indent)).join(', ')},`,
    ...children.map((child) => `${inner}${reindented(child.text, child.from, inner)},`),
    `${indent})`,
  ].join('\n');
}

const EMPTY_EXPRESSION = 'An attribute is given a value: `{}` holds none.';

/**
 * Why an attribute `__proto__` given a value is refused: React's transforms write it into an object
 * literal, where it sets the props' prototype, and React's `jsx` hands the component what they
 * inherit — the authority reads their own fields alone. Given text, or nothing, it sets none, and is
 * dropped alike on both sides.
 */
const INHERITED =
  "An attribute `__proto__` given a value — in braces, or an element — sets what the props inherit rather than a prop: React hands the component what that value holds, and what the authority renders reads the props' own fields alone. Name the attribute otherwise.";

/** The props of an element: `null` where it has no attribute, as React's transform writes it. */
function propsOf(attributes: JsxAttributes, rendering: Rendering): Piece {
  const { fail, sourceFile } = rendering;
  if (attributes.properties.length === 0) {
    return plain('null');
  }
  const parts = attributes.properties.map((attribute) => {
    if (isJsxSpreadAttribute(attribute)) {
      return `...${rendering.expression(attribute.expression)}`;
    }
    const name = attributeName(attribute.name);
    if (name === 'children') {
      fail(
        'What the authority renders is given its children between its tags, not as an attribute: `<p>{text}</p>`.',
        attribute,
      );
    }
    const { initializer } = attribute;
    if (name === '__proto__' && initializer !== undefined && !isStringLiteral(initializer)) {
      fail(INHERITED, attribute);
    }
    let value: string;
    if (initializer === undefined) {
      value = 'true';
    } else if (isStringLiteral(initializer)) {
      value = literal(jsxAttributeString(initializer.text));
    } else if (isJsxExpression(initializer)) {
      value = rendering.expression(initializer.expression ?? fail(EMPTY_EXPRESSION, initializer));
    } else {
      value = rendered(initializer, rendering);
    }
    return `${propertyName(name)}: ${value}`;
  });
  return {
    from: indentAt(sourceFile.text, attributes.getStart(sourceFile)),
    text: `{ ${parts.join(', ')} }`,
  };
}

function attributeName(name: JsxAttributeName): string {
  return isJsxNamespacedName(name) ? `${name.namespace.text}:${name.name.text}` : name.text;
}

/** The children of an element or a fragment, as React's transform passes them. */
function childrenOf(children: readonly JsxChild[], rendering: Rendering): readonly Piece[] {
  const pieces: Piece[] = [];
  for (const child of children) {
    if (isJsxText(child)) {
      const text = jsxTextChild(child.text);
      if (text !== undefined) {
        pieces.push(plain(literal(text)));
      }
      continue;
    }
    if (isJsxExpression(child)) {
      if (child.dotDotDotToken !== undefined) {
        rendering.fail(
          'JSX spreads no children: React has none of it, so neither does what the authority renders. Give the list as one child — `{items}` — whose items have keys.',
          child,
        );
      }
      if (child.expression !== undefined) {
        pieces.push(pieceOf(child.expression, rendering.expression(child.expression), rendering));
      }
      continue;
    }
    pieces.push(pieceOf(child, rendered(child, rendering), rendering));
  }
  return pieces;
}

/** How an element's type is written in the authority's program, from its tag. */
export function typeOfTag(tag: JsxTagNameExpression, fail: Fail): string {
  if (isJsxNamespacedName(tag)) {
    return literal(`${tag.namespace.text}:${tag.name.text}`);
  }
  if (isIdentifier(tag)) {
    // React takes a tag that starts with a lowercase letter, or holds a dash, for the browser's own.
    return /^[a-z]/u.test(tag.text) || tag.text.includes('-') ? literal(tag.text) : tag.text;
  }
  return fail(
    "An element the authority renders is a tag of the browser's, or a component imported by name: `<Link>`, not `<ui.Link>` — the authority renders it by reference, by its export's name.",
    tag,
  );
}
