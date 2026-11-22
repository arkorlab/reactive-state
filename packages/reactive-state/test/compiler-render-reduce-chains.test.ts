import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * A pipeline of array methods in a custom tag is one question per stage of it, whatever the
 * methods: a Date a tag is given is followed through twenty-two stages as through two. Each row
 * runs in a Node of its own that is killed after twenty seconds, as a stage that asks its
 * receiver twice doubles the work at every stage.
 */

const COMPILER = fileURLToPath(new URL('../src/compiler/', import.meta.url));
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const STAGES = 22;
const KILL_AFTER = 20_000;

const SCRIPT = [
  "import { pathToFileURL } from 'node:url';",
  `const load = (file) => import(pathToFileURL(${JSON.stringify(COMPILER)} + file).href);`,
  "const { openTypeScript, parseModule } = await load('typescript.ts');",
  "const { isTypeOnly } = await load('scope.ts');",
  "const { renderLocalInput } = await load('render-local-inputs.ts');",
  'using api = openTypeScript();',
  "using parsed = parseModule(api, 'reduce-chains.tsx', process.argv[2]);",
  'const pending = [parsed.sourceFile];',
  'let found;',
  'for (let node = pending.pop(); node !== undefined; node = pending.pop()) {',
  '  if (isTypeOnly(node)) continue;',
  '  found ??= renderLocalInput(node);',
  '  const children = [];',
  '  node.forEachChild((child) => { children.push(child); });',
  '  pending.push(...children.toReversed());',
  '}',
  "console.log(found === undefined ? 'taken' : 'refused');",
  '',
].join('\n');

const SPREAD = '.reduce((out,value)=>[...out,value],[])';
const ELEMENT = '.reduce((_total,value)=>value,null)';
const BARE = '.reduce((_total,value)=>value)';
const PUSH = '.reduce((out,value)=>{out.push(value);return out;},[])';
const TEXT = '.reduce((text,value)=>text+String(value.length),"")';
const FILTER = '.filter(()=>true)';
const MAP = '.map((value)=>value)';
const NAMED_MAP = '.map(identity)';
const IDENTITY = 'const identity=(value:unknown)=>value;';

const CASES = [
  { id: 'reductions-building-an-array', stage: SPREAD, verdict: 'refused' },
  { id: 'reductions-returning-the-element', stage: ELEMENT, verdict: 'refused' },
  { id: 'reductions-without-an-initial-value-pin', stage: BARE, verdict: 'refused' },
  { id: 'reductions-pushing-into-the-accumulator', stage: PUSH, verdict: 'refused' },
  { id: 'reductions-building-text-pin', stage: TEXT, verdict: 'taken' },
  { id: 'maps-with-a-named-callback', stage: NAMED_MAP, pre: IDENTITY, verdict: 'refused' },
  { id: 'filters-pin', stage: FILTER, verdict: 'refused' },
  { id: 'maps-pin', stage: MAP, verdict: 'refused' },
  {
    id: 'filter-reduce-map-reduce-pipeline',
    stage: `${FILTER}${SPREAD}${MAP}${ELEMENT}`,
    verdict: 'refused',
  },
] as const;

async function verdictOf(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-reduce-chains-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const script = path.join(directory, 'chain.mts');
  await writeFile(script, SCRIPT);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script, source], {
      cwd: PACKAGE,
      timeout: KILL_AFTER,
    });
    return stdout.trim();
  } catch (error) {
    return `failed: ${(error as { readonly code?: number | string }).code ?? 'killed'}`;
  }
}

describe('a pipeline of array methods in a tag', () => {
  it.each(CASES)(
    '$id',
    async (row) => {
      const { stage, verdict } = row;
      const pre = 'pre' in row ? row.pre : '';
      const tag = `(_s:TemplateStringsArray,...values:unknown[])=>String(values${stage.repeat(STAGES)})`;
      const source = `${pre}export function Widget(){const tag=${tag};return <p>{tag\`\${new Date(0)}\`}</p>;}`;

      await expect(verdictOf(source)).resolves.toBe(verdict);
    },
    KILL_AFTER + 10_000,
  );
});
