import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native constructor prototype queries retain Error identity without value-space shadowing. */
const CASES = [
  {
    name: 'native Error prototype query',
    declaration: 'type Failure = typeof Error.prototype;',
    error: true,
  },
  {
    name: 'native TypeError prototype query',
    declaration: 'type Failure = typeof TypeError.prototype;',
    error: true,
  },
  {
    name: 'local alias to native prototype query',
    declaration: 'type Prototype = typeof Error.prototype; type Failure = Prototype;',
    error: true,
  },
  {
    name: 'shadowed Error constructor value data',
    declaration:
      'const Error = { prototype: { stack: "fixed" } }; type Failure = typeof Error.prototype;',
    error: false,
  },
  {
    name: 'shadowed TypeError constructor value data',
    declaration:
      'const TypeError = { prototype: { stack: "fixed" } }; type Failure = typeof TypeError.prototype;',
    error: false,
  },
  {
    name: 'ordinary application prototype query',
    declaration:
      'const Data = { prototype: { stack: "fixed" } }; type Failure = typeof Data.prototype;',
    error: false,
  },
  {
    name: 'type-only Error name preserves native value query',
    declaration: 'type Error = { stack: string }; type Failure = typeof Error.prototype;',
    error: true,
  },
  {
    name: 'global-qualified native Error prototype query',
    declaration: 'type Failure = typeof globalThis.Error.prototype;',
    error: true,
  },
  {
    name: 'shadowed globalThis value prototype query data',
    declaration:
      'const globalThis = { Error: { prototype: { stack: "fixed" } } }; type Failure = typeof globalThis.Error.prototype;',
    error: false,
  },
] as const;

describe('native error prototype query reader identity', () => {
  it.each(CASES)('$name', (row) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'error-prototype-query.ts',
      `${row.declaration} function frames(error: Failure) { return error.stack; }`,
    );
    const pending: Node[] = [parsed.sourceFile];
    const reads: string[] = [];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const framed = framedRead(node);
      if (framed !== undefined) reads.push(framed);
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(reads.length > 0).toBe(row.error);
  });
});

describe('native error prototype query actual shared helpers', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$name', async (row) => {
    const app = await fixture(row.declaration);
    apps.push(app);
    const compiled = compile(app);
    const reasons = compiled.refusals.map((refusal) => refusal.reason);
    const refused = [expect.stringContaining('a shared module that answers otherwise')];

    expect(reasons).toStrictEqual(row.error ? refused : []);
  });
});

/** A selected dynamic child prop makes the ordinary shared module admission observable. */
async function fixture(declaration: string): Promise<Application> {
  return application({
    'domain/error-query.ts': [
      declaration,
      'function frames(error: Failure): string { return error.stack ?? ""; }',
      'export function label(value: string) { return value + frames({ name: "fixed", message: value, stack: value }); }',
    ].join('\n'),
    'components/error-query.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/error-query';",
      'export default function ErrorQuery({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
