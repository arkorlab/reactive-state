import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A chain of local subclasses whose constructors each pass on what they read of their parameter,
 * `super(options.value)`, hands the values one layer forwards to the next: each layer forwards
 * what it was given, beside what it reads of it. A value reached two ways is forwarded once, so a
 * chain forwards as many values as there are different ones (before, each layer doubled the values
 * it was given, and twenty layers of a class hierarchy made 2^20 of them: the compile ran out of
 * stack). More than a limit of them is a program no constructor is written as, and it is refused
 * outright, whatever the construction supplies and whatever a default holds: a wrapper nested as
 * deep as the chain (`{ inner: { value: { inner: { value: error } } } }`) is refused, and so is an
 * `Error` that a default of the last class alone holds. A chain under the limit is followed: its
 * argument stays among what is forwarded, and a wrapper of a text is taken. Each row runs in a
 * process of its own, killed after a few seconds. The process starts in the package's own
 * directory, where `typescript/ast` is the package's TypeScript, whichever directory the tests are
 * run from.
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

/**
 * The classes of a chain, each extending the one before, whose constructor is `constructor`, the
 * last one's `last`.
 */
function chain(layers: number, constructor: string, last = constructor): string {
  const classes = [`class C0 extends Error { ${layers === 0 ? last : constructor} }`];
  for (let layer = 1; layer <= layers; layer += 1)
    classes.push(
      `class C${layer} extends C${layer - 1} { ${layer === layers ? last : constructor} }`,
    );
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
  last = constructor,
): {
  readonly answers: readonly (readonly [string, string])[];
  readonly refused: boolean;
  readonly signal: string | null;
} {
  const text = `declare const error: Error; ${chain(layers, constructor, last)} ${source}`;
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
      const { answers, refused, signal } = forwardedBy(each, LAYERS.many);

      expect({
        bounded: answers.length > 0 && answers.length < 1000,
        keepsTheArgument: refused || answers.some(([written]) => written === each.supplied),
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
      'is taken where it holds a text, with four layers (pin)',
      () => {
        const { refused, signal } = run(`new C4(${nest(4, '"fixed"')});`, constructor, 4);

        expect({ refused, signal }).toStrictEqual({ refused: false, signal: null });
      },
      ROW_SECONDS,
    );
  });
});

describe('a chain of constructors that forwards more than it can follow, or stays under the limit', () => {
  it(
    'follows a chain of nine layers of one key that holds a text, and takes it (pin)',
    () => {
      const { refused, signal } = run(
        `new C9(${valued(9, '"fixed"')});`,
        'constructor(options: any) { super(options.value); }',
        9,
      );

      expect({ refused, signal }).toStrictEqual({ refused: false, signal: null });
    },
    ROW_SECONDS,
  );

  it(
    'follows twenty layers of one key that hold a text, and takes it (pin)',
    () => {
      const { refused, signal } = run(
        `new C20(${valued(20, '"fixed"')});`,
        'constructor(options: any) { super(options.value); }',
        20,
      );

      expect({ refused, signal }).toStrictEqual({ refused: false, signal: null });
    },
    ROW_SECONDS,
  );

  it(
    'refuses twenty layers of a path of two keys, whatever it holds: no constructor is written so',
    () => {
      const { refused, signal } = run(
        `new C20(${wrapped(20, '"fixed"')});`,
        'constructor(options: any) { super(options.inner.value); }',
        20,
      );

      expect({ refused, signal }).toStrictEqual({ refused: true, signal: null });
    },
    ROW_SECONDS,
  );
});

describe('an Error a default of the last class holds, nested as deep as the chain is long', () => {
  const DEPTHS = [10, 20, 40] as const;
  const PATHS = [
    {
      constructor: 'constructor(options: any) { super(options.inner.value); }',
      last: (nested: string) =>
        `constructor(options: any = ${nested}) { super(options.inner.value); }`,
      nest: wrapped,
      what: 'a path of two keys',
    },
    {
      constructor: 'constructor(options: any) { super(options.value); }',
      last: (nested: string) => `constructor(options: any = ${nested}) { super(options.value); }`,
      nest: valued,
      what: 'a member',
    },
  ] as const;

  describe.each(PATHS)('$what', ({ constructor, last, nest }) => {
    it.each(DEPTHS)(
      'is refused with %i layers, supplied by the default alone',
      (layers) => {
        const { refused, signal } = run(
          `new C${layers}();`,
          constructor,
          layers,
          last(nest(layers, 'error')),
        );

        expect({ refused, signal }).toStrictEqual({ refused: true, signal: null });
      },
      ROW_SECONDS,
    );
  });
});

describe('a program the compile cannot follow into the constructors', () => {
  const UNFOLLOWED = [
    {
      constructor:
        'constructor(...[{ ...rest } = { message: error }]: any[]) { super(rest.message); }',
      source: 'new C0();',
      what: 'an Error a default of a pattern holds, supplied by the default alone',
    },
    {
      constructor:
        'constructor(...[{ ...rest } = { message: { inner: error } }]: any[]) { super(rest.message.inner); }',
      source: 'new C0();',
      what: 'an Error a default of a pattern holds below the top, by the default alone',
    },
    {
      constructor: 'constructor(...[{ ...rest }]: any[]) { super(rest.message); }',
      source: 'new C0({ message: error });',
      what: 'an Error an argument holds, given to a pattern that is not followed',
    },
  ] as const;

  it.each(UNFOLLOWED)(
    'is refused: $what',
    ({ constructor, source }) => {
      const { refused, signal } = run(source, constructor, 0);

      expect({ refused, signal }).toStrictEqual({ refused: true, signal: null });
    },
    ROW_SECONDS,
  );

  it(
    'is taken where what it holds is a text (pin)',
    () => {
      const { refused, signal } = run(
        'new C0({ message: "fixed" });',
        'constructor(...[{ ...rest }]: any[]) { super(rest.message); }',
        0,
      );

      expect({ refused, signal }).toStrictEqual({ refused: false, signal: null });
    },
    ROW_SECONDS,
  );
});
