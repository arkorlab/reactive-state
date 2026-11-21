import {
  type ArrowFunction,
  formatSyntaxKind,
  type FunctionExpression,
  type Identifier,
  isAwaitExpression,
  isCallExpression,
  isIdentifier,
  isLiteralExpression,
  isNewExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isShorthandPropertyAssignment,
  isTaggedTemplateExpression,
  isTemplateLiteralToken,
  isVariableDeclarationList,
  isYieldExpression,
  type Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclarationList,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import type { Fail } from './errors.ts';
import type { ImportBinding } from './imports.ts';
import { isJsx } from './jsx.ts';
import { isTypeOnly, readsBinding, walk } from './scope.ts';
import { functionOf } from './statements.ts';
import { useOf } from './uses.ts';

/**
 * An update a setter is given — `current => addEstimate(current, step)` — as both sides run it: the
 * authority, for the write, of the field's current value and of the values the call captured when
 * it was made; the browser, to predict it. It reads its parameter, what it captures — the owner's
 * props, its states' values, its constants that are no function, a hook's parameters — the
 * application's shared modules, and globals: what both sides have alike, and nothing else.
 */

/** A value an update captures, which its call sends, and its type in the authority's program. */
interface Capture {
  readonly name: string;
  readonly type: string;
}

export interface Update {
  readonly fn: ArrowFunction | FunctionExpression;
  readonly sourceFile: SourceFile;
  /** The current value's name, where the update reads it. */
  readonly parameter: Identifier | undefined;
  /** What it captures, in the order its body first reads each. */
  readonly captures: readonly Capture[];
  /** The imports of the application's shared modules it reads, at run time or in a type. */
  readonly imports: readonly ImportBinding[];
  /**
   * What it computes, in a form of the compiler's own rather than as it is printed, so that neither
   * a formatter nor how the update is named or written — inline, or as a constant — moves its id.
   */
  readonly form: string;
}

/** What an update's names are read against: the code it is written in. */
export interface UpdateScope {
  readonly names: ReadonlyMap<string, TopLevel>;
  readonly declared: ReadonlySet<string>;
  readonly declaring: ReadonlySet<Node>;
  readonly sourceFile: SourceFile;
  readonly fail: Fail;
  /** The type of a value an update captures, in the authority's program; refused where it has none. */
  readonly captureType: (name: Identifier) => string;
  /** Whether a name the code holds is a function, or a setter, which an update captures none of. */
  readonly holdsFunction: (name: Identifier) => boolean;
}

const ONLY =
  "An update reads the current value, the values it captures — props, states' values, constants that are no function, a hook's parameters — the application's shared modules and globals, and nothing else: the authority runs it, with what the call captured, and the browser predicts it alike.";

export function readUpdate(fn: ArrowFunction | FunctionExpression, scope: UpdateScope): Update {
  const { fail, sourceFile } = scope;
  const [parameter, ...others] = fn.parameters;
  if (
    others.length > 0 ||
    fn.typeParameters !== undefined ||
    fn.asteriskToken !== undefined ||
    fn.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true ||
    (parameter !== undefined &&
      (!isIdentifier(parameter.name) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined ||
        parameter.questionToken !== undefined))
  ) {
    return fail(
      `An update is a function of the current value alone — \`(current) => expression\` — synchronous, which the authority runs as it is: ${fn.getText(sourceFile)} is not.`,
      fn,
    );
  }
  const captures = new Map<string, Capture>();
  const imports = new Map<string, ImportBinding>();
  walk(
    fn,
    { declared: scope.declared, declaring: scope.declaring, topLevel: new Set(scope.names.keys()) },
    {
      node: (node) => {
        if (
          node.kind === SyntaxKind.ThisKeyword ||
          isAwaitExpression(node) ||
          isYieldExpression(node)
        ) {
          fail(ONLY, node);
        }
        if (isJsx(node)) {
          fail(
            `An update makes the field's next value of the current one, and JSX is rendered, not held: ${ONLY}`,
            node,
          );
        }
      },
      read: (identifier, space) => {
        readName(identifier, space, { captures, imports, scope });
      },
      unresolved: (identifier) => {
        fail(`\`${identifier.text}\` is not in the update's scope: ${ONLY}`, identifier);
      },
    },
    fail,
  );
  const name = parameter !== undefined && isIdentifier(parameter.name) ? parameter.name : undefined;
  return {
    captures: [...captures.values()],
    fn,
    form: formOf(fn.body, { captures, imports, parameter: name?.text }),
    imports: [...imports.values()],
    parameter: name,
    sourceFile,
  };
}

interface Reading {
  readonly captures: Map<string, Capture>;
  readonly imports: Map<string, ImportBinding>;
  readonly scope: UpdateScope;
}

function readName(identifier: Identifier, space: 'type' | 'value', reading: Reading): void {
  const { captures, imports, scope } = reading;
  const entry = scope.names.get(identifier.text);
  if (entry === undefined) {
    return;
  }
  if (entry.kind === 'import') {
    if (space === 'value' && entry.binding.module.target.kind !== 'shared') {
      scope.fail(
        `\`${identifier.text}\` is \`${entry.binding.module.specifier}\`'s, which is no shared module of the application's — one that runs anywhere alike — so the authority and the browser cannot both run it: ${ONLY}`,
        identifier,
      );
    }
    imports.set(identifier.text, entry.binding);
    return;
  }
  if (space === 'type') {
    scope.fail(
      `\`${identifier.text}\` is a type of the component's own, which an update's types do not name: ${ONLY}`,
      identifier,
    );
  }
  switch (entry.kind) {
    case 'constant':
    case 'hooked':
    case 'param':
    case 'prop':
    case 'state': {
      capture(identifier, entry, { captures, scope });
      break;
    }
    case 'intrinsic':
    case 'module':
    case 'node':
    case 'self':
    case 'server':
    case 'setter': {
      scope.fail(`\`${identifier.text}\` cannot be read by an update: ${ONLY}`, identifier);
    }
  }
}

/** The members of a function that a call goes through: `onSave.call(…)`. */
const CALLING: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/**
 * Whether the update calls what `identifier` names — `onSave()`, `onSave?.()`, `new onSave()`, a
 * template it tags, `onSave.call(…)` — within parentheses, `!`, `satisfies` and casts (`useOf`). What is called is a
 * function, whatever type its owner gives it: an alias or an interface that a component or a hook
 * imports is no type this compile reads, and its member, or the parameter, may be one.
 */
function isCalled(identifier: Identifier): boolean {
  const { at, parent } = useOf(identifier);
  if (isPropertyAccessExpression(parent) && parent.expression === at) {
    const member = useOf(parent);
    return (
      CALLING.has(parent.name.text) &&
      isCallExpression(member.parent) &&
      member.parent.expression === member.at
    );
  }
  return (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    (isTaggedTemplateExpression(parent) && parent.tag === at)
  );
}

/**
 * A value of the owner's an update reads, which its call captures: never a function, whether the
 * owner's code says so — a function declared, a function type written — or the update calls it.
 */
function capture(
  identifier: Identifier,
  entry: TopLevel,
  reading: Pick<Reading, 'captures' | 'scope'>,
): void {
  const { captures, scope } = reading;
  if (entry.kind === 'constant' && functionOf(entry.declaration) !== undefined) {
    scope.fail(
      `\`${identifier.text}\` is a function, which an update does not capture: ${ONLY}`,
      identifier,
    );
  }
  if (scope.holdsFunction(identifier) || isCalled(identifier)) {
    scope.fail(
      `\`${identifier.text}\` is a function, which an update does not capture: ${ONLY}`,
      identifier,
    );
  }
  if (!captures.has(identifier.text)) {
    captures.set(identifier.text, {
      name: identifier.text,
      type: scope.captureType(identifier),
    });
  }
}

interface Forming {
  readonly parameter: string | undefined;
  readonly captures: ReadonlyMap<string, Capture>;
  readonly imports: ReadonlyMap<string, ImportBinding>;
}

/**
 * An update's body as the compiler's own form: each node by its kind, the current value as `$`,
 * what it captures by name, what it imports by module and export, and a literal by its value — the
 * text of a template's parts between its substitutions, and a private name, among them, which no
 * child of theirs holds. Types are no part of it, nor how a node is spelled. A shorthand property
 * is both its key and its value, and the value is `$` or a capture: its key is a part of the form
 * as well, or `left => ({ left })` and `right => ({ right })` would be one update; and so is the kind
 * of a declaration, `let` or `const` or `var`, which `{ let r = n; { let r = 0; } return r; }` is
 * another update of than the same with `var`.
 */
function formOf(node: Node, forming: Forming): string {
  if (isIdentifier(node)) {
    return identifierForm(node, forming);
  }
  if (isLiteralExpression(node) || isTemplateLiteralToken(node) || isPrivateIdentifier(node)) {
    return `${formatSyntaxKind(node.kind)}:${JSON.stringify(node.text)}`;
  }
  const parts: string[] = [...besideChildren(node)];
  node.forEachChild((child) => {
    if (!isTypeOnly(child)) {
      parts.push(formOf(child, forming));
    }
  });
  const operator =
    isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)
      ? `:${formatSyntaxKind(node.operator)}`
      : '';
  return `${formatSyntaxKind(node.kind)}${operator}(${parts.join(',')})`;
}

/** What a node is beside its children: a shorthand property's key, and the kind of a declaration list. */
function besideChildren(node: Node): readonly string[] {
  if (isShorthandPropertyAssignment(node) && isIdentifier(node.name)) {
    return [`name:${node.name.text}`];
  }
  return isVariableDeclarationList(node) ? [`declares:${declaresWith(node)}`] : [];
}

/** What a list declares with — `let`, `const`, `var` or `using`: the first word of its text, which no child of the list holds. */
function declaresWith(list: VariableDeclarationList): string {
  return /^[a-z]+/u.exec(list.getText(list.getSourceFile()))?.[0] ?? '';
}

function identifierForm(identifier: Identifier, forming: Forming): string {
  const { text } = identifier;
  if (!readsBinding(identifier)) {
    return `name:${text}`;
  }
  if (text === forming.parameter) {
    return '$';
  }
  if (forming.captures.has(text)) {
    return `capture:${text}`;
  }
  const binding = forming.imports.get(text);
  return binding === undefined
    ? `ref:${text}`
    : `import:${binding.module.specifier}#${binding.exported}`;
}
