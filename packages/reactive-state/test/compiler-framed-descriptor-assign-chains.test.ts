import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Sources that copy one another, each into the next from the two before it or twice from the one
 * before, make a program that grows by a line a level and names one value. The walk of what is
 * written into a descriptor follows each object once, however many sources name it, so its work
 * and what it returns grow with the program: a chain run in a child process, which is killed where
 * a walk down every path would still be running.
 */
const LIMITS = { depth: 30, fibonacci: 40, kill: 30_000, wait: 60_000 } as const;
const COMPILER = fileURLToPath(new URL('../src/compiler/', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/** Each level copies the one before it twice. */
function doubling(depth: number): string {
  const lines = ['const s0 = { value: e };'];
  for (let level = 1; level <= depth; level += 1)
    lines.push(
      `const s${level} = { value: e }; Object.assign(s${level}, s${level - 1}, s${level - 1});`,
    );
  lines.push(`Object.assign(d, s${depth});`);
  return lines.join('\n');
}

/** Each level copies the two before it. */
function fibonacci(depth: number): string {
  const lines = ['const s0 = { value: e };', 'const s1 = { value: e };'];
  for (let level = 2; level <= depth; level += 1)
    lines.push(
      `const s${level} = { value: e }; Object.assign(s${level}, s${level - 1}, s${level - 2});`,
    );
  lines.push(`Object.assign(d, s${depth});`);
  return lines.join('\n');
}

/** The declarations the source of a chain is read after. */
const HEADER = [
  'declare const source: object;',
  'declare const e: Error;',
  'declare function use(value: unknown): void;',
  "const d = Object.getOwnPropertyDescriptor(source, 'x')!;",
].join(' ');

/** What a child process reports of the writes into `d` the source holds: which, and how many nodes. */
function reported(source: string): ReturnType<typeof spawnSync> {
  const module = (name: string): string => JSON.stringify(COMPILER + name);
  const text = [HEADER, source, 'use(d.value);'].join('\n');
  const script = [
    `const { openTypeScript, parseModule } = await import(${module('typescript.ts')});`,
    `const { framedDescriptorWrites } = await import(${module('framed-descriptor-writes.ts')});`,
    "const { isCallExpression, isIdentifier, isPropertyAccessExpression } = await import('typescript/ast');",
    `const text = ${JSON.stringify(text)};`,
    'using api = openTypeScript();',
    "using parsed = parseModule(api, 'chain.ts', text);",
    'let read;',
    'const pending = [parsed.sourceFile];',
    'for (let node = pending.pop(); node !== undefined; node = pending.pop()) {',
    "  if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'use' && isPropertyAccessExpression(node.arguments[0])) read = node.arguments[0].expression;",
    '  node.forEachChild((child) => { pending.push(child); });',
    '}',
    'const written = framedDescriptorWrites(read);',
    'console.log(JSON.stringify({ texts: [...new Set(written.map((each) => each.getText()))], nodes: new Set(written.map((each) => each.pos)).size }));',
  ].join('\n');

  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: PACKAGE,
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    timeout: LIMITS.kill,
  });
}

describe('descriptor writes through sources that copy one another', () => {
  it(
    'follows a source copied twice at each of thirty levels once',
    () => {
      const ran = reported(doubling(LIMITS.depth));

      expect(ran.signal).toBeNull();
      expect(JSON.parse(String(ran.stdout))).toStrictEqual({
        texts: ['e'],
        nodes: LIMITS.depth + 1,
      });
    },
    LIMITS.wait,
  );

  it(
    'follows the two sources copied at each of forty levels once',
    () => {
      const ran = reported(fibonacci(LIMITS.fibonacci));

      expect(ran.signal).toBeNull();
      expect(JSON.parse(String(ran.stdout))).toStrictEqual({
        texts: ['e'],
        nodes: LIMITS.fibonacci + 1,
      });
    },
    LIMITS.wait,
  );

  it(
    'reads a short chain as it reads one source',
    () => {
      const ran = reported(doubling(2));

      expect(ran.signal).toBeNull();
      expect(JSON.parse(String(ran.stdout))).toStrictEqual({ texts: ['e'], nodes: 3 });
    },
    LIMITS.wait,
  );
});
