import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isBlock, isFunctionDeclaration, type Node, type Statement } from 'typescript/ast';
import { afterEach, describe, expect, it } from 'vitest';

import { failIn, ReactiveCompileError } from '../src/compiler/errors.ts';
import { guardAnswers } from '../src/compiler/middleware-response.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The response a guard answers, as the program writes it, against the response its source middleware
 * gives (`return new Response(…)`): the same status, the same headers by name and value, the same
 * text — or the compile refuses the middleware, where the program could not give what the source
 * does. Each row runs both: the source's own `new Response` as it is, and the guard's answer with
 * the descriptor the compile writes in its place.
 */

interface Answered {
  readonly status?: number;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: string;
  readonly threw?: string;
}

const dirs: string[] = [];

/** Removes the modules the rows ran: called when each test ends. */
function cleanUp(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

const byName = (a: readonly [string, string], b: readonly [string, string]): number =>
  a[0].localeCompare(b[0]);

/** The status, the headers by name and the text of a response, or of a descriptor. */
async function normalized(answer: unknown): Promise<Answered> {
  if (answer instanceof Response) {
    return {
      body: await answer.text(),
      headers: [...answer.headers].toSorted(byName),
      status: answer.status,
    };
  }
  const { body, headers, status } = answer as Required<Omit<Answered, 'threw'>>;
  return { body, headers: [...headers].toSorted(byName), status };
}

/** Runs `source`, a function of no parameter, as a module of its own: what it answers, or throws. */
async function run(source: string): Promise<Answered> {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-guard-'));
  dirs.push(dir);
  const file = path.join(dir, 'guard.mts');
  writeFileSync(file, `export default ${source};\n`);
  try {
    const guard = ((await import(pathToFileURL(file).href)) as { default: () => Promise<unknown> })
      .default;
    return await normalized(await guard());
  } catch (error) {
    return { threw: error instanceof TypeError ? 'TypeError' : String(error) };
  }
}

/** A guard to answer as its source does: its statements before the answer, the answer, the names it declares. */
interface Row {
  readonly prelude?: string;
  readonly answer: string;
  readonly declared?: readonly string[];
}

/** The middleware's guard, `async () => { <prelude> return <answer>; }`, with its answer made a descriptor. */
function guardOf({ answer, declared = [], prelude = '' }: Row): {
  readonly source: string;
  readonly emitted: string;
} {
  const source = `async () => { ${prelude} return ${answer}; }`;
  using api = openTypeScript();
  using parsed = parseModule(api, 'guard.ts', `const guard = ${source};`);
  const { sourceFile } = parsed;
  let statements: readonly Statement[] = [];
  const visit = (node: Node): void => {
    if (isBlock(node) && !isFunctionDeclaration(node.parent) && statements.length === 0) {
      ({ statements } = node);
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  const { answers } = guardAnswers(statements, sourceFile, {
    fail: failIn(sourceFile, 'guard.ts'),
    local: (name) => declared.includes(name),
  });
  const spans = [...answers].map(([node, text]) => {
    return {
      end: node.getEnd(),
      start: node.getStart(sourceFile),
      text,
    };
  });
  const lastFirst = spans.toSorted((a, b) => b.start - a.start);
  let emitted = sourceFile.text;
  for (const { end, start, text } of lastFirst) {
    emitted = `${emitted.slice(0, start)}${text}${emitted.slice(end)}`;
  }
  return { emitted: emitted.replace(/^const guard = /u, '').replace(/;$/u, ''), source };
}

/** What the source's response and the guard's descriptor each answer, run. */
async function both(row: Row): Promise<{ readonly source: Answered; readonly emitted: Answered }> {
  const { emitted, source } = guardOf(row);
  return { emitted: await run(emitted), source: await run(source) };
}

describe('a guard that answers what its source middleware gives', () => {
  afterEach(cleanUp);

  it('answers a header written as a name and a value', async () => {
    const { emitted, source } = await both({
      answer: "new Response('x', { headers: { vary: 'a' } })",
    });

    expect(emitted).toStrictEqual(source);
    expect(source.headers).toContainEqual(['vary', 'a']);
  });

  it('answers a header written as a shorthand property', async () => {
    const { emitted, source } = await both({
      answer: "new Response('x', { headers: { vary } })",
      prelude: "const vary = 'Cookie';",
    });

    expect(emitted).toStrictEqual(source);
    expect(source.headers).toContainEqual(['vary', 'Cookie']);
  });

  it.each([
    { id: 'a letter escaped', name: String.raw`\u0076ary`, declared: 'vary', header: 'vary' },
    {
      id: 'an upper-case letter escaped',
      name: String.raw`\u0058Test`,
      declared: 'XTest',
      header: 'xtest',
    },
    { id: 'a code point escaped', name: String.raw`\u{76}ary`, declared: 'vary', header: 'vary' },
  ])(
    'answers a shorthand header whose name is written escaped: $id',
    async ({ declared, header, name }) => {
      const { emitted, source } = await both({
        answer: `new Response('x', { headers: { ${name} } })`,
        prelude: `const ${declared} = 'Cookie';`,
      });

      expect(emitted).toStrictEqual(source);
      expect(source.headers).toContainEqual([header, 'Cookie']);
    },
  );

  it.each([
    { id: 'no body, as `void 0`', body: 'void 0' },
    { id: 'no body, as `null`', body: 'null' },
    { id: 'text', body: "'hi'" },
  ])(
    'answers a body the guard computes where it declares its own `undefined`: $id',
    async ({ body }) => {
      const { emitted, source } = await both({
        answer: "new Response(body, { headers: { 'x-note': note } })",
        declared: ['undefined'],
        prelude: `const undefined = 'local'; const note = undefined; const body = ${body};`,
      });

      expect(source.headers).toContainEqual(['x-note', 'local']);
      expect(emitted).toStrictEqual(source);
    },
  );

  it.each([
    {
      id: 'a spread of one item',
      prelude: "const parts: [string] = ['one'];",
      answer: "new Response('x', { headers: [['x-test', ...parts]] })",
    },
    {
      id: 'a spread that makes three items',
      prelude: "const parts: string[] = ['one']; parts.push('two');",
      answer: "new Response('x', { headers: [['x-test', ...parts]] })",
    },
    {
      id: 'a spread first',
      prelude: "const parts: string[] = ['x-test'];",
      answer: "new Response('x', { headers: [[...parts, 'one']] })",
    },
  ])('refuses a header pair that holds a spread: $id', ({ answer, prelude }) => {
    expect(() => guardOf({ answer, prelude })).toThrow(ReactiveCompileError);
  });

  it('answers a header pair of two items', async () => {
    const { emitted, source } = await both({
      answer: "new Response('x', { headers: [['x-test', 'one']] })",
    });

    expect(emitted).toStrictEqual(source);
    expect(source.headers).toContainEqual(['x-test', 'one']);
  });
});
