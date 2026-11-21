import {
  type BindingName,
  isIdentifier,
  isObjectBindingPattern,
  type Node,
  type ObjectBindingPattern,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { PROTOCOL_VERSION } from '../program.ts';
import { header } from './emit-authority.ts';
import { importDeclarations, type ImportLine } from './imports.ts';
import type { Part } from './middleware-parts.ts';
import { unionOf } from './middleware-reads.ts';
import type { MiddlewareSplit } from './middleware.ts';
import { bindingIdentifiers } from './scope.ts';
import { indentAt, literal, reindented, splicedFrom, unusedName } from './splice.ts';

/**
 * What a compile writes of a route middleware: its guard, as a program the authority runs
 * (`middleware/<…>.guard.mts`, a `MiddlewareProgram`), and its envelope, as a module the host runs
 * around each request (`middleware/<…>.envelope.ts`, a `MiddlewareEnvelope`). Each is the
 * middleware's own code, spliced from its source as written (`splice.ts`), with the imports it reads
 * as the middleware wrote them.
 */

/** The module the routing contract's types are imported from. */
const ROUTING = '@arkorlab/reactive-state/routing';

/** How deep a part's statements are written: in the body of a function at the top level. */
const BODY_INDENT = '  ';

/** The type the contract hands a middleware's context with, where the middleware declares none. */
function contractContext(routeParams: string): string {
  return `{ readonly request: Request; readonly params: ${routeParams} }`;
}

/** A name of the contract's an output imports, under a name none of the middleware's takes. */
function ownName(split: MiddlewareSplit, name: string): string {
  const { declared, names } = split.names;
  return unusedName(name, (each) => names.topLevel.has(each) || declared.has(each));
}

/** `import type { … } from '@arkorlab/reactive-state/routing'` of `names`, each as an output names it. */
function routingImport(names: ReadonlyMap<string, string>): readonly string[] {
  if (names.size === 0) {
    return [];
  }
  const named = [...names].map(([name, local]) => (name === local ? name : `${name} as ${local}`));
  return [`import type { ${named.join(', ')} } from '${ROUTING}';`];
}

/** A module's first evaluating declaration, including bindings the selected part never reads. */
function evaluationOrderOf(split: MiddlewareSplit): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  for (const { module } of split.names.imports.values()) {
    const identity = module.target.file ?? module.specifier;
    if (
      module.declaration.importClause?.phaseModifier !== SyntaxKind.TypeKeyword &&
      !order.has(identity)
    ) {
      order.set(identity, module.declaration.pos);
    }
  }
  return order;
}

/** The imports a part reads, preserving the source's module evaluation even for type-position reads. */
function importsOf(
  split: MiddlewareSplit,
  values: ReadonlySet<string>,
  types: ReadonlySet<string>,
  part: 'envelope' | 'guard',
): readonly string[] {
  const order = evaluationOrderOf(split);
  const modules = new Map<string, { evaluates: boolean; lines: ImportLine[]; order: number }>();
  for (const [name, binding] of split.names.imports) {
    if (!values.has(name) && !types.has(name)) {
      continue;
    }
    const { target, written, declaration, specifier } = binding.module;
    const evaluates = declaration.importClause?.phaseModifier !== SyntaxKind.TypeKeyword;
    const { kind } = target;
    if (
      evaluates &&
      (kind === 'client' ||
        kind === 'component' ||
        kind === 'hooks' ||
        (part === 'guard' ? kind === 'element' : kind === 'server' || kind === 'operations'))
    ) {
      split.names.fail(
        `The import of \`${name}\` evaluates \`${specifier}\` at run time, which the ${part === 'guard' ? "authority's guard" : "host's envelope"} cannot run. Use \`import type\` where only its type is needed.`,
        binding.name,
      );
    }
    let imported = modules.get(written);
    if (imported === undefined) {
      imported = {
        evaluates: false,
        lines: [],
        order: order.get(target.file ?? specifier) ?? declaration.pos,
      };
      modules.set(written, imported);
    }
    imported.evaluates ||= evaluates;
    imported.lines.push({ binding, from: written, typeOnly: binding.typeOnly });
  }
  return [...modules]
    .toSorted(([, left], [, right]) => left.order - right.order)
    .flatMap(([from, { evaluates, lines }]) => {
      return [
        // Inline type specifiers keep module evaluation under verbatimModuleSyntax; `import type` does not.
        ...(evaluates && lines.every((line) => line.typeOnly) ? [`import ${from};`] : []),
        ...importDeclarations(lines),
      ];
    });
}

/**
 * The pattern a part binds the context by: the middleware's own, holding only the names `keep`
 * keeps — each element as written, an object nested in it kept as far as it holds any of them, with
 * its default. What a default it keeps reads, the part binds and imports too (`patternReads`).
 */
function patternOf(
  pattern: ObjectBindingPattern,
  keep: (name: string) => boolean,
  sourceFile: SourceFile,
): string | undefined {
  const kept = pattern.elements.flatMap((element) => {
    const name: BindingName | undefined = element.name;
    if (name === undefined) {
      return [];
    }
    if (isIdentifier(name) || !isObjectBindingPattern(name)) {
      const held = bindingIdentifiers(name).some((identifier) => keep(identifier.text));
      return held ? [element.getText(sourceFile)] : [];
    }
    const inner = patternOf(name, keep, sourceFile);
    const key = element.propertyName?.getText(sourceFile);
    const initializer = element.initializer?.getText(sourceFile);
    return inner === undefined || key === undefined
      ? []
      : [initializer === undefined ? `${key}: ${inner}` : `${key}: ${inner} = ${initializer}`];
  });
  return kept.length === 0 ? undefined : `{ ${kept.join(', ')} }`;
}

/** How a part binds the context's names it reads: the context's name, or its pattern; none for none. */
function contextBinding(split: MiddlewareSplit, part: Part): string | undefined {
  const { context, sourceFile } = split.names;
  if (context === undefined || part.context.length === 0) {
    return undefined;
  }
  return context.kind === 'whole'
    ? context.name.text
    : patternOf(context.pattern, (name) => part.context.includes(name), sourceFile);
}

/**
 * A part's statements as the middleware holds them, written in a function's body: each node
 * `answers` holds replaced by what it holds for it (a guard's own response, its descriptor).
 */
function bodyOf(
  statements: readonly Statement[],
  sourceFile: SourceFile,
  answers?: ReadonlyMap<Node, string>,
): string {
  const [first] = statements;
  if (first === undefined) {
    return '';
  }
  const indent = indentAt(sourceFile.text, first.getStart(sourceFile));
  const text = statements
    .map((statement) =>
      splicedFrom(statement, statement.pos, sourceFile, (node) => answers?.get(node)),
    )
    .join('')
    .replace(/^\n+/u, '');
  return reindented(`\n${text}`, indent, BODY_INDENT).slice(1);
}

/** The guard program of `split`, which has a guard (`middleware/<…>.guard.mts`). */
export function emitGuard(split: MiddlewareSplit, buildId: string): string {
  const { guard } = split;
  if (guard === undefined) {
    throw new Error(`The middleware ${split.fileName} has no guard to write.`);
  }
  const { sourceFile } = split.names;
  const helpers = new Map<string, string>();
  const binding = contextBinding(split, guard);
  const declared = split.contextType;
  // The names the context's type reads, where the guard binds the context by it.
  const types = unionOf(guard.types, binding === undefined ? undefined : declared?.reads);
  let parameter = '';
  if (binding !== undefined) {
    if (declared === undefined) {
      helpers.set('RouteParams', ownName(split, 'RouteParams'));
    }
    parameter =
      declared === undefined
        ? `${binding}: { readonly params: ${helpers.get('RouteParams') ?? ''} }`
        : `${binding}: Pick<${declared.text}, 'params'>`;
  }
  let answer = '';
  if (guard.answers.size > 0) {
    const descriptor = ownName(split, 'ResponseDescriptor');
    helpers.set('ResponseDescriptor', descriptor);
    answer = split.isAsync ? `: Promise<${descriptor} | void>` : `: ${descriptor} | void`;
  }
  return [
    header(split.fileName, 'middleware'),
    ...routingImport(helpers),
    ...importsOf(split, guard.values, types, 'guard'),
    '',
    // The platform's globals the program makes a response by, where the middleware declares a name
    // of theirs: bound here, where none of its own is in scope (`guardAnswers`).
    ...[...guard.globals].map(([global, name]) => `const ${name} = globalThis.${global};`),
    ...(guard.globals.size === 0 ? [] : ['']),
    `export const protocolVersion = ${String(PROTOCOL_VERSION)};`,
    `export const buildId = ${literal(buildId)};`,
    `export const id = ${literal(split.id)};`,
    '',
    `export ${split.isAsync ? 'async ' : ''}function guard(${parameter})${answer} {`,
    bodyOf(guard.statements, sourceFile, guard.answers),
    '}',
    '',
  ].join('\n');
}

/** The envelope's `before`, its lines, and the names of the contract's it reads. */
function beforeLines(
  split: MiddlewareSplit,
  helpers: Map<string, string>,
  types: Set<string>,
): readonly string[] {
  const { before } = split;
  if (before === undefined) {
    return [];
  }
  const { sourceFile } = split.names;
  const binding = contextBinding(split, before);
  const lines: string[] = [];
  let parameter = '';
  if (binding !== undefined) {
    const routeParams = ownName(split, 'RouteParams');
    helpers.set('RouteParams', routeParams);
    const declared = split.contextType;
    if (declared === undefined) {
      parameter = `${binding}: ${contractContext(routeParams)}`;
    } else {
      const context = ownName(split, 'context');
      parameter = `${context}: ${contractContext(routeParams)}`;
      lines.push(`${BODY_INDENT}const ${binding} = ${context} as ${declared.text};`);
      for (const name of declared.reads) {
        types.add(name);
      }
    }
  }
  const body = bodyOf(before.statements, sourceFile);
  return [
    `export ${before.awaits ? 'async ' : ''}function before(${parameter}) {`,
    ...lines,
    ...(body === '' ? [] : [body]),
    `${BODY_INDENT}return { ${before.locals.join(', ')} };`.replace('{  }', '{}'),
    '}',
  ];
}

/**
 * The envelope's `after`, its lines: what `before` answered read under names none of the
 * middleware's declares anywhere — its parameter, and the type of it, named at the top level where
 * `before` is the envelope's own, not a name the part after `next` declares itself.
 */
function afterLines(split: MiddlewareSplit): readonly string[] {
  const { after } = split;
  if (after === undefined) {
    return [];
  }
  const { sourceFile } = split.names;
  const declared = (name: string): boolean =>
    split.names.names.topLevel.has(name) || split.names.declared.has(name);
  // The response keeps the middleware's name where the part reads it; where it does not, the
  // parameter is one of the emitter's own, by a name the middleware declares nowhere.
  const response = after.values.has(after.response.text)
    ? after.response.text
    : unusedName(`_${after.response.text}`, declared);
  const handedName = (base: string): string =>
    unusedName(base, (each) => each === response || declared(each));
  const signature = (locals: string): string =>
    `export ${after.awaits ? 'async ' : ''}function after(${locals}: Readonly<Record<string, unknown>>, ${response}: Response): ${after.awaits ? 'Promise<void>' : 'void'} {`;
  if (after.locals.length === 0) {
    return [signature(handedName('_locals')), bodyOf(after.statements, sourceFile), '}'];
  }
  const locals = handedName('locals');
  const handed = ownName(split, 'Handed');
  return [
    `type ${handed} = Awaited<ReturnType<typeof before>>;`,
    '',
    signature(locals),
    `${BODY_INDENT}const { ${after.locals.join(', ')} } = ${locals} as ${handed};`,
    bodyOf(after.statements, sourceFile),
    '}',
  ];
}

/** The envelope module of `split`, which has one (`middleware/<…>.envelope.ts`). */
export function emitEnvelope(split: MiddlewareSplit): string {
  const helpers = new Map<string, string>();
  const types = unionOf(split.before?.types, split.after?.types);
  const before = beforeLines(split, helpers, types);
  const after = afterLines(split);
  const values = unionOf(split.before?.values, split.after?.values);
  return [
    header(split.fileName, 'middleware'),
    ...routingImport(helpers),
    ...importsOf(split, values, types, 'envelope'),
    '',
    `export const id = ${literal(split.id)};`,
    ...(before.length === 0 ? [] : ['', ...before]),
    ...(after.length === 0 ? [] : ['', ...after]),
    '',
  ].join('\n');
}
