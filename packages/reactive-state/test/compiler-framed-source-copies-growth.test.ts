import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Whether code may have changed a constant before `Object.assign` copies it is read from an index of
 * the module's mentions and aliases, made once for the module: a module of many small constants,
 * each copied, costs in proportion to its size, not to the square of it, as a walk of the whole
 * module for each constant would (two thousand copies took a quarter of a minute), and a name that
 * many functions declare is told apart by the declaration each mention stands for, once for each
 * mention, not once for each declaration of the name. Each row runs in
 * a process of its own, killed after a few seconds, so a reader that does not return in time fails
 * its row and no more. The process starts in the package's own directory, where `typescript/ast` is
 * the package's TypeScript, whichever directory the tests are run from.
 */
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const WRITES = fileURLToPath(new URL('../src/compiler/framed-member-writes.ts', import.meta.url));
const TYPESCRIPT = fileURLToPath(new URL('../src/compiler/typescript.ts', import.meta.url));
const COPIES = 2000;
const SECONDS = 8000;
const ROW_SECONDS = 20_000;

const SCRIPT = [
  `const { framedMemberWrites } = await import(${JSON.stringify(WRITES)});`,
  `const { openTypeScript, parseModule } = await import(${JSON.stringify(TYPESCRIPT)});`,
  'const [count, shape] = process.argv.slice(1);',
  'const lines = [];',
  "if (shape === 'plain' || shape === 'handed') lines.push('export function frames(error: Error, touch: (value: unknown) => void) {', 'const box: Record<string, unknown> = { x: error };');",
  'for (let at = 0; at < Number(count); at += 1) {',
  "  if (shape.startsWith('same-name')) {",
  "    lines.push('export function f' + at + '(error: Error) { const box: Record<string, unknown> = { x: error }; const source = { x: ' + at + ' };');",
  "    if (shape === 'same-name-alias') lines.push('const alias = source;');",
  "    lines.push('Object.assign(box, ' + (shape === 'same-name-alias' ? 'alias' : 'source') + '); return String(box.x); }');",
  '    continue;',
  '  }',
  "  lines.push('const source' + at + ' = { x: ' + at + ' };');",
  "  if (shape === 'handed') lines.push('touch(source' + at + ');');",
  "  lines.push('Object.assign(box, source' + at + ');');",
  '}',
  "if (shape === 'plain' || shape === 'handed') lines.push('return String(box.x);', '}');",
  'const api = openTypeScript();',
  "const parsed = parseModule(api, 'source-copies.ts', lines.join(' '));",
  'const writes = framedMemberWrites(parsed.sourceFile);',
  'console.log(JSON.stringify({ writes: writes.length, reopened: writes.filter((write) => write.reopened).length }));',
  'process.exit(0);',
].join('\n');

const CASES = [
  { id: 'constants-copied-and-never-changed', shape: 'plain', reopened: 0 },
  { id: 'constants-copied-and-handed-to-a-call', shape: 'handed', reopened: COPIES },
  { id: 'one-name-in-as-many-functions', shape: 'same-name', reopened: 0 },
  { id: 'one-name-and-one-alias-in-as-many-functions', shape: 'same-name-alias', reopened: 0 },
] as const;

describe('a module of many constants each copied by Object.assign', () => {
  it.each(CASES)(
    '$id',
    ({ reopened, shape }) => {
      const ran = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', SCRIPT, String(COPIES), shape],
        {
          cwd: PACKAGE,
          encoding: 'utf8',
          timeout: SECONDS,
        },
      );

      expect({ output: ran.stdout.trim(), signal: ran.signal }).toStrictEqual({
        output: JSON.stringify({ writes: COPIES, reopened }),
        signal: null,
      });
    },
    ROW_SECONDS,
  );
});
