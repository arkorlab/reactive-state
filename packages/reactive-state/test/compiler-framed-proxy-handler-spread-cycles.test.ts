import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A Proxy handler is read through the object spreads it is made of. A spread of a constant that is
 * being expanded already — `const handler = { ...handler, get }`, which throws a ReferenceError
 * where it runs, a name read before its initializer — is not followed again: the old reader
 * expanded it for ever (it never returned, or grew without end where the cycle held a trap). The
 * same literal spread twice, one after the other, is no cycle: the later spread still replaces what
 * the entries between them wrote. Each row runs in a process of its own, killed after a few
 * seconds, so a reader that does not return fails its row and no more.
 */
const PROXY = fileURLToPath(
  new URL('../src/compiler/framed-proxy-get-results.ts', import.meta.url),
);
const TYPESCRIPT = fileURLToPath(new URL('../src/compiler/typescript.ts', import.meta.url));
const SECONDS = 5000;
const ROW_SECONDS = 20_000;

const SCRIPT = [
  "import { isExpressionStatement, isPropertyAccessExpression } from 'typescript/ast';",
  `const { framedProxyGetMember } = await import(${JSON.stringify(PROXY)});`,
  `const { openTypeScript, parseModule } = await import(${JSON.stringify(TYPESCRIPT)});`,
  'const api = openTypeScript();',
  "const parsed = parseModule(api, 'proxy-handler.ts', process.argv[1]);",
  'let read;',
  'const visit = (node) => {',
  '  if (isExpressionStatement(node) && isPropertyAccessExpression(node.expression)) read = node.expression;',
  '  node.forEachChild(visit);',
  '};',
  'visit(parsed.sourceFile);',
  'const answers = framedProxyGetMember(',
  '  read.expression,',
  '  [read.name.text],',
  "  (value) => value.getText(parsed.sourceFile) === 'error',",
  ');',
  'console.log(JSON.stringify({ answers }));',
  'process.exit(0);',
].join('\n');

const CASES = [
  {
    answers: true,
    id: 'a-handler-that-spreads-itself-before-its-trap',
    source: 'const handler = { ...handler, get() { return error; } }; new Proxy({}, handler).x;',
  },
  {
    answers: true,
    id: 'a-handler-that-spreads-itself-after-its-trap',
    source: 'const handler = { get() { return error; }, ...handler }; new Proxy({}, handler).x;',
  },
  {
    answers: false,
    id: 'two-handlers-that-spread-each-other',
    source: 'const a = { ...b }; const b = { ...a }; new Proxy({}, a).x;',
  },
  {
    answers: true,
    id: 'two-handlers-that-spread-each-other-holding-a-trap',
    source: 'const a = { get() { return error; }, ...b }; const b = { ...a }; new Proxy({}, a).x;',
  },
  {
    answers: true,
    id: 'a-cycle-through-a-constant-alias',
    source:
      'const a = { ...c }; const b = a; const c = { ...b, get() { return error; } }; new Proxy({}, a).x;',
  },
  {
    answers: true,
    id: 'a-cycle-of-three-spreads',
    source:
      'const a = { ...b }; const b = { ...c }; const c = { ...a, get() { return error; } }; new Proxy({}, a).x;',
  },
  {
    answers: true,
    id: 'the-same-handler-spread-twice-after-a-replacing-trap-is-no-cycle',
    source:
      'const base = { get() { return error; } }; const handler = { ...base, get: () => safe, ...base }; new Proxy({}, handler).x;',
  },
  {
    answers: false,
    id: 'the-same-handler-spread-twice-before-a-replacing-trap-is-no-cycle',
    source:
      'const base = { get() { return error; } }; const handler = { ...base, ...base, get: () => safe }; new Proxy({}, handler).x;',
  },
  {
    answers: true,
    id: 'two-handlers-that-spread-one-constant-each',
    source:
      'const base = { get() { return error; } }; const left = { ...base }; const right = { ...base }; const handler = { ...left, ...right }; new Proxy({}, handler).x;',
  },
  {
    answers: true,
    id: 'a-spread-of-a-constant-handler-with-a-trap',
    source:
      'const base = { get() { return error; } }; const handler = { ...base }; new Proxy({}, handler).x;',
  },
] as const;

describe('a Proxy handler made of object spreads', () => {
  it.each(CASES)(
    '$id',
    ({ answers, source }) => {
      const ran = spawnSync(process.execPath, ['--input-type=module', '--eval', SCRIPT, source], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: SECONDS,
      });

      expect({ output: ran.stdout.trim(), signal: ran.signal }).toStrictEqual({
        output: JSON.stringify({ answers }),
        signal: null,
      });
    },
    ROW_SECONDS,
  );
});
