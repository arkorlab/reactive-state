import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Defaults that read one another in a circle, `constructor(a = b.x, b = a.y)`, make a path that
 * grows by a key at each turn: the member path a `super` argument selects is followed through each
 * default the construction leaves taken, and a default that is entered again on the way is a circle.
 * Where it runs the program throws a ReferenceError (a parameter read before it is initialized), so
 * it is a mistake the compile meets before the program runs. Such a program is read as one the
 * compile cannot follow: every argument of the construction stays possible, which the rows show as
 * the argument `error` that no `super` argument names. A circle that adds no key to the path
 * (`a = b, b = a`), one among defaults the construction replaces (which drop the path), and one
 * through the elements of a rest parameter (which may or may not be taken) meet a state they have
 * scanned and end of themselves, as they did; defaults that name one another without a circle are
 * followed. Each row runs in a process of its own, killed after a few
 * seconds, so a reader that does not return fails its row and no more. The process starts in the
 * package's own directory, where `typescript/ast` is the package's TypeScript, whichever directory
 * the tests are run from.
 */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const MESSAGES = fileURLToPath(
  new URL('../src/compiler/framed-subclass-messages.ts', import.meta.url),
);
const TYPESCRIPT = fileURLToPath(new URL('../src/compiler/typescript.ts', import.meta.url));
const SECONDS = 5000;
const ROW_SECONDS = 20_000;

const SCRIPT = [
  "import { isIdentifier, isNewExpression } from 'typescript/ast';",
  `const { framedSubclassMessages } = await import(${JSON.stringify(MESSAGES)});`,
  `const { openTypeScript, parseModule } = await import(${JSON.stringify(TYPESCRIPT)});`,
  'const api = openTypeScript();',
  "const parsed = parseModule(api, 'cycle.ts', process.argv[1]);",
  'let made;',
  'const visit = (node) => {',
  '  if (made === undefined && isNewExpression(node) && isIdentifier(node.expression)) made = node;',
  '  node.forEachChild(visit);',
  '};',
  'visit(parsed.sourceFile);',
  "const values = framedSubclassMessages(made, new Set(['Error']));",
  'const answers = (values ?? []).map((each) => [',
  '  each.value.getText(parsed.sourceFile),',
  "  [...each.keys, ...(each.any === true ? ['*'] : [])].join('.'),",
  ']);',
  'console.log(JSON.stringify(answers));',
  'process.exit(0);',
].join('\n');

interface Case {
  /** Whether the `error` the construction gives no parameter that `super` reads stays possible. */
  readonly closed: boolean;
  readonly id: string;
  readonly source: string;
}

const CASES: readonly Case[] = [
  {
    closed: true,
    id: 'two-defaults-that-read-each-other',
    source:
      'class Failure extends Error { constructor(a: any = b.x, b: any = a.y, ignored?: unknown) { super(a); } } new Failure(undefined, undefined, error);',
  },
  {
    closed: true,
    id: 'a-default-that-reads-itself',
    source:
      'class Failure extends Error { constructor(a: any = a.x, ignored?: unknown) { super(a); } } new Failure(undefined, error);',
  },
  {
    closed: true,
    id: 'three-defaults-in-a-circle',
    source:
      'class Failure extends Error { constructor(a: any = b.x, b: any = c.y, c: any = a.z, ignored?: unknown) { super(a); } } new Failure(undefined, undefined, undefined, error);',
  },
  {
    closed: true,
    id: 'a-circle-through-a-members-member',
    source:
      'class Failure extends Error { constructor(a: any = b.x.y, b: any = a.p.q, ignored?: unknown) { super(a); } } new Failure(undefined, undefined, error);',
  },
  {
    closed: true,
    id: 'a-circle-through-the-pattern-of-a-parameter',
    source:
      'class Failure extends Error { constructor(a: any = b.x, { b = a.y }: { b?: any } = {}, ignored?: unknown) { super(a); } } new Failure(undefined, undefined, error);',
  },
  {
    closed: false,
    id: 'two-defaults-that-name-each-other-and-select-no-member-pin',
    source:
      'class Failure extends Error { constructor(a: any = b, b: any = a, ignored?: unknown) { super(a); } } new Failure(undefined, undefined, error);',
  },
  {
    closed: false,
    id: 'a-circle-through-a-rest-pattern-ends-of-itself-pin',
    source:
      'class Failure extends Error { constructor(a: any = b.x, ...[b = a.y]: any[]) { super(a); } } new Failure(undefined, undefined, error);',
  },
  {
    closed: false,
    id: 'a-circle-of-defaults-the-construction-replaces-pin',
    source:
      'class Failure extends Error { constructor(a: any = b.x, b: any = a.y, ignored?: unknown) { super(a); } } new Failure({ x: error }, { y: error }, error);',
  },
  {
    closed: false,
    id: 'defaults-that-name-one-another-without-a-circle-pin',
    source:
      'class Failure extends Error { constructor(fallback: unknown, a: any = fallback as { message: unknown }, b: any = a, ignored?: unknown) { super(b.message); } } new Failure({ message: "fixed" }, undefined, undefined, error);',
  },
];

describe('constructor defaults that read one another in a circle', () => {
  it.each(CASES)(
    '$id',
    ({ closed, source }) => {
      const ran = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', SCRIPT, `declare const error: Error; ${source}`],
        { cwd: PACKAGE, encoding: 'utf8', killSignal: 'SIGKILL', timeout: SECONDS },
      );
      const answers: readonly (readonly [string, string])[] =
        ran.stdout.trim() === '' ? [] : (JSON.parse(ran.stdout) as []);

      expect({
        forwarded: answers.some(([written, path]) => written === 'error' && path === ''),
        signal: ran.signal,
      }).toStrictEqual({ forwarded: closed, signal: null });
    },
    ROW_SECONDS,
  );
});
