import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A Proxy handler is read through the object spreads it is made of, and handlers that spread handlers
 * that spread handlers, each twice (`const h1 = { ...h0, ...h0 }; const h2 = { ...h1, ...h1 };`),
 * cost the product of their spreads: twenty-five levels were some sixty-seven million visits, and a
 * few more never returned. A walk now visits a thousand spreads; past them the handler is read as
 * holding a trap of anything, so a read through the Proxy may select an error: it is refused, as a
 * handler the compile cannot follow is. Within them nothing changes: a trap that spread twice and
 * replaced between the two spreads still answers the later one. Each row runs in a process of its
 * own, killed after a few seconds, so a reader that does not return fails its row and no more. The
 * process starts in the package's own directory, where `typescript/ast` is the package's
 * TypeScript, whichever directory the tests are run from. The rows marked a pin answer the same
 * before this change as after it.
 */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
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

/** A handler of `levels` levels, each spreading the one before twice, and the read through it. */
function chain(levels: number, trap: string): string {
  const lines = [`const h0 = { get() { return ${trap}; } };`];
  for (let level = 1; level <= levels; level += 1) {
    lines.push(`const h${String(level)} = { ...h${String(level - 1)}, ...h${String(level - 1)} };`);
  }
  lines.push(`new Proxy({}, h${String(levels)}).x;`);
  return lines.join(' ');
}

const CASES = [
  {
    answers: true,
    id: 'a-chain-of-twenty-five-levels-of-an-error-trap',
    source: chain(25, 'error'),
  },
  {
    answers: true,
    id: 'a-chain-of-twenty-five-levels-of-a-trap-that-is-no-error',
    source: chain(25, '1'),
  },
  {
    answers: true,
    id: 'a-chain-of-ten-levels-is-past-the-visits-of-a-walk',
    source: chain(10, '1'),
  },
  {
    answers: false,
    id: 'a-chain-of-eight-levels-is-within-them-pin',
    source: chain(8, '1'),
  },
  {
    answers: true,
    id: 'a-chain-of-five-levels-of-an-error-trap-pin',
    source: chain(5, 'error'),
  },
  {
    answers: true,
    id: 'a-trap-spread-twice-with-a-replacing-trap-between-pin',
    source:
      'const base = { get() { return error; } }; const handler = { ...base, get: () => safe, ...base }; new Proxy({}, handler).x;',
  },
  {
    answers: false,
    id: 'a-trap-spread-twice-before-a-replacing-trap-pin',
    source:
      'const base = { get() { return error; } }; const handler = { ...base, ...base, get: () => safe }; new Proxy({}, handler).x;',
  },
  {
    answers: true,
    id: 'a-handler-that-spreads-itself-pin',
    source: 'const handler = { ...handler, get() { return error; } }; new Proxy({}, handler).x;',
  },
] as const;

describe('a Proxy handler made of object spreads that share object spreads', () => {
  it.each(CASES)(
    '$id',
    ({ answers, source }) => {
      const ran = spawnSync(process.execPath, ['--input-type=module', '--eval', SCRIPT, source], {
        cwd: PACKAGE,
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
