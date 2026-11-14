import { type Node, type SourceFile } from 'typescript/ast';

/**
 * What a compile writes of the application's code, it writes as the source holds it — its comments,
 * its numbers and its quotes, its lines — and rewrites only what it must: JSX the authority renders,
 * a state the authority computes, a registered update. TypeScript's printer would write the same
 * code again from its tree, without the comments and with every number in its own form, so the
 * outputs are spliced from the source text instead, around the nodes rewritten.
 */

/** What replaces a node of the source in what is written: its text, or nothing to keep it. */
export type Rewrite = (node: Node) => string | undefined;

/**
 * The text of `node` as the source holds it, from its first token, with each node within it that
 * `rewrite` answers for replaced by what it answers. A node replaced is not entered: what replaces
 * it is written whole by the rewrite, which splices what it keeps of it itself.
 */
export function spliced(node: Node, sourceFile: SourceFile, rewrite: Rewrite): string {
  return splicedFrom(node, node.getStart(sourceFile), sourceFile, rewrite);
}

/** `spliced`, from `start` — the node's full start, to keep the comments that lead it. */
export function splicedFrom(
  node: Node,
  start: number,
  sourceFile: SourceFile,
  rewrite: Rewrite,
): string {
  const { text } = sourceFile;
  let written = '';
  let at = start;
  const visit = (child: Node): void => {
    const replacement = rewrite(child);
    if (replacement === undefined) {
      child.forEachChild(visit);
      return;
    }
    written += text.slice(at, child.getStart(sourceFile)) + replacement;
    at = child.end;
  };
  node.forEachChild(visit);
  return written + text.slice(at, node.end);
}

/** `node` itself rewritten, or its text with what is within it rewritten. */
export function textOf(node: Node, sourceFile: SourceFile, rewrite: Rewrite): string {
  return rewrite(node) ?? spliced(node, sourceFile, rewrite);
}

/** The white space a line of `text` begins with, for the line `position` is on. */
export function indentAt(text: string, position: number): string {
  const start = text.lastIndexOf('\n', position - 1) + 1;
  return /^[\t ]*/u.exec(text.slice(start, position))?.[0] ?? '';
}

/**
 * `text`, whose lines after its first were indented from `from`, indented from `to` instead. Text
 * that holds a template literal, or a line a backslash continues (`'one \` …), is left as it is: a
 * line of either is a string's content, not its indent.
 */
export function reindented(text: string, from: string, to: string): string {
  if (from === to || text.includes('`') || /\\\r?\n/u.test(text)) {
    return text;
  }
  return text
    .split('\n')
    .map((line, index) =>
      index > 0 && line.startsWith(from) ? to + line.slice(from.length) : line,
    )
    .join('\n');
}

/** A string as a TypeScript literal: every string the compile writes is JSON's, which TypeScript reads. */
export function literal(value: string): string {
  return JSON.stringify(value);
}

/** Whether `name` can be written as it is where a property is named, or must be quoted. */
export function propertyName(name: string): string {
  return /^[$A-Z_a-z][\w$]*$/u.test(name) ? name : literal(name);
}

/**
 * Orders two strings by their UTF-16 code units: the order every machine sorts them in alike, as a
 * locale's collation is not — the build's id hashes what is sorted by it.
 */
export function byCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** `base`, or else `base$2`, `base$3`…: the first of them `taken` does not hold. */
export function unusedName(base: string, taken: (name: string) => boolean): string {
  let name = base;
  let index = 1;
  while (taken(name)) {
    index += 1;
    name = `${base}$${String(index)}`;
  }
  return name;
}

/** A module's specifier as an import writes it: in single quotes, as the application writes them. */
export function specifierLiteral(specifier: string): string {
  return /^[^\n\r'\\]*$/u.test(specifier) ? `'${specifier}'` : literal(specifier);
}
