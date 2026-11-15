import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A chain of local subclasses whose constructors each pass on what they read of their parameter,
 * `super(options.value)`, hands the values one layer forwards to the next: each layer forwards
 * what it was given, beside what it reads of it. A value reached two ways is forwarded once, so a
 * chain forwards as many values as there are different ones, and more than a limit of them is read
 * as a program the compile cannot follow, which keeps every argument of the construction possible
 * (the argument `{ value: error }` stays among what is forwarded). Before, each layer doubled the
 * values it was given, and twenty layers of a class hierarchy made 2^20 of them: the compile ran
 * out of stack. A program read as one the compile cannot follow is refused where an `Error` may
 * reach the message through any member of an argument, at any depth: a wrapper nested as deep as
 * the chain (`{ inner: { value: { inner: { value: error } } } }`) is refused, as it is where the
 * chain is followed, and the same wrapper of a text is not. Each row runs in a process of its own,
 * killed after a few seconds. The process starts in the package's own directory, where
 * `typescript/ast` is the package's TypeScript, whichever directory the tests are run from.
 */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const MESSAGES = fileURLToPath(
  new URL('../src/compiler/framed-subclass-messages.ts', import.meta.url),
);
const REFUSALS = fileURLToPath(
  new URL('../src/compiler/framed-error-messages.ts', import.meta.url),
);
const BOUNDED = fileURLToPath(new URL('../src/compiler/bounded.ts', import.meta.url));
const TYPESCRIPT = fileURLToPath(new URL('../src/compiler/typescript.ts', import.meta.url));
const SECONDS = 8000;
const ROW_SECONDS = 30_000;
const LAYERS = { few: 4, many: 20 } as const;

const SCRIPT = [
  "import { isIdentifier, isNewExpression } from 'typescript/ast';",
  `const { framedSubclassMessages } = await import(${JSON.stringify(MESSAGES)});`,
  `const { framedErrorMessage } = await import(${JSON.stringify(REFUSALS)});`,
  `const { unwrapped } = await import(${JSON.stringify(BOUNDED)});`,
  `const { openTypeScript, parseModule } = await import(${JSON.stringify(TYPESCRIPT)});`,
  'const api = openTypeScript();',
  "const parsed = parseModule(api, 'chain.ts', process.argv[1]);",
  'let made;',
  'const visit = (node) => {',
  '  if (made === undefined && isNewExpression(node) && isIdentifier(node.expression)) made = node;',
  '  node.forEachChild(visit);',
  '};',
  'visit(parsed.sourceFile);',
  "const names = new Set(['Error']);",
  'const values = framedSubclassMessages(made, names) ?? [];',
  "const isError = (value, keys = []) => keys.length === 0 && isIdentifier(unwrapped(value)) && unwrapped(value).text === 'error';",
  'const refused = framedErrorMessage(made, names, isError, () => false);',
  'const answers = values.map((each) => [',
  '  each.value.getText(parsed.sourceFile),',
  "  [...each.keys, ...(each.any === true ? ['*'] : [])].join('.'),",
  ']);',
  'console.log(JSON.stringify({ answers, refused }));',
  'process.exit(0);',
].join('\n');

/** The classes of a chain, each extending the one before, whose constructor is `constructor`. */
function chain(layers: number, constructor: string): string {
  const classes = [`class C0 extends Error { ${constructor} }`];
  for (let layer = 1; layer <= layers; layer += 1)
    classes.push(`class C${layer} extends C${layer - 1} { ${constructor} }`);
  return classes.join(' ');
}

interface Case {
  /** The construction of the last class, from the number of its layers. */
  readonly made: (layers: number) => string;
  /** The argument of the construction that holds the error, as it is written. */
  readonly supplied: string;
  /** The constructor every layer writes. */
  readonly constructor: string;
  readonly what: string;
}

const MEMBER: Case = {
  constructor: 'constructor(options: any) { super(options.value); }',
  made: (layers) => `new C${layers}({ value: error });`,
  supplied: '{ value: error }',
  what: 'a member of the parameter',
};

const CASES: readonly Case[] = [
  MEMBER,
  {
    constructor: 'constructor(fallback: any, options = fallback as any) { super(options.value); }',
    made: (layers) => `new C${layers}({ value: error });`,
    supplied: '{ value: error }',
    what: 'a member of a default the construction leaves taken',
  },
  {
    constructor: 'constructor(first: any, second: any) { super(first.value, second.value); }',
    made: (layers) => `new C${layers}({ value: error }, { value: error });`,
    supplied: '{ value: error }',
    what: 'two parameters, each read by a member',
  },
  {
    constructor: 'constructor(...args: any[]) { super(args[0].value); }',
    made: (layers) => `new C${layers}({ value: error });`,
    supplied: '{ value: error }',
    what: 'an argument a rest parameter holds',
  },
  {
    constructor: 'constructor({ value }: any) { super({ value }); }',
    made: (layers) => `new C${layers}({ value: error });`,
    supplied: '{ value: error }',
    what: 'a name a pattern binds, passed on in an object',
  },
  {
    constructor: 'constructor(options: any) { super(options.inner.value); }',
    made: (layers) => `new C${layers}({ inner: { value: error } });`,
    supplied: '{ inner: { value: error } }',
    what: 'a path of two keys, which a layer makes longer',
  },
];

/** What the construction of the last of `layers` layers forwards, `[written, path]`, and whether it is refused. */
function run(
  source: string,
  constructor: string,
  layers: number,
): {
  readonly answers: readonly (readonly [string, string])[];
  readonly refused: boolean;
  readonly signal: string | null;
} {
  const text = `declare const error: Error; ${chain(layers, constructor)} ${source}`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '--eval', SCRIPT, text], {
    cwd: PACKAGE,
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    timeout: SECONDS,
  });
  const out = ran.stdout.trim();
  const parsed = out === '' ? { answers: [], refused: false } : JSON.parse(out);
  return { ...(parsed as { answers: []; refused: boolean }), signal: ran.signal };
}

function forwardedBy({ constructor, made }: Case, layers: number): ReturnType<typeof run> {
  return run(made(layers), constructor, layers);
}

/** `inner` wrapped `depth` times around `leaf`, each wrapper `{ inner: { value: … } }`. */
function wrapped(depth: number, leaf: string): string {
  let text = leaf;
  for (let level = 0; level < depth; level += 1) text = `{ inner: { value: ${text} } }`;
  return text;
}

/** `leaf` wrapped `depth` times as `{ value: … }`. */
function valued(depth: number, leaf: string): string {
  let text = leaf;
  for (let level = 0; level < depth; level += 1) text = `{ value: ${text} }`;
  return text;
}

describe('a chain of constructors that pass on what they read of a parameter', () => {
  it.each(CASES)(
    'forwards a bounded number of values through many layers: $what',
    (each) => {
      const { answers, signal } = forwardedBy(each, LAYERS.many);

      expect({
        bounded: answers.length > 0 && answers.length < 1000,
        keepsTheArgument: answers.some(([written]) => written === each.supplied),
        signal,
      }).toStrictEqual({ bounded: true, keepsTheArgument: true, signal: null });
    },
    ROW_SECONDS,
  );

  it(
    'follows a short chain through every layer (pin)',
    () => {
      const { answers } = forwardedBy(MEMBER, LAYERS.few);
      const path = Array.from({ length: LAYERS.few }, () => 'value').join('.');

      expect(answers.some(([written, at]) => written === '{ value: error }' && at === path)).toBe(
        true,
      );
    },
    ROW_SECONDS,
  );
});

describe('an Error nested as deep as a chain of constructors is long', () => {
  const DEPTHS = [9, 20, 40] as const;
  const PATHS = [
    {
      constructor: 'constructor(options: any) { super(options.inner.value); }',
      nest: wrapped,
      what: 'a path of two keys',
    },
    {
      constructor: 'constructor(options: any) { super(options.value); }',
      nest: valued,
      what: 'a member',
    },
  ] as const;

  describe.each(PATHS)('$what', ({ constructor, nest }) => {
    it.each(DEPTHS)(
      'is refused with %i layers',
      (layers) => {
        const { refused, signal } = run(
          `new C${layers}(${nest(layers, 'error')});`,
          constructor,
          layers,
        );

        expect({ refused, signal }).toStrictEqual({ refused: true, signal: null });
      },
      ROW_SECONDS,
    );

    it(
      'is taken where it holds a text, with twenty layers (pin)',
      () => {
        const { refused, signal } = run(`new C20(${nest(20, '"fixed"')});`, constructor, 20);

        expect({ refused, signal }).toStrictEqual({ refused: false, signal: null });
      },
      ROW_SECONDS,
    );
  });
});
