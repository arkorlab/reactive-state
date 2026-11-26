import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Optional method positions retain their implicit undefined in either whole variance relation. */
const COUNTS = { regressions: 4 } as const;

const CASES = [
  {
    name: 'optional-target-undefined-domain-error',
    source:
      'type R<T>=T extends {make(value?:string):infer U}?U:Error;type Failure=R<{make(value:string|number):{stack:string}}>;function read(error:Failure){return error.stack;}',
    expected: true,
  },
  {
    name: 'optional-target-undefined-domain-data',
    source:
      'type R<T>=T extends {make(value?:string):infer U}?U:{stack:string};type Failure=R<{make(value:string|number):Error}>;function read(error:Failure){return error.stack;}',
    expected: false,
  },
  {
    name: 'optional-source-undefined-domain-error',
    source:
      'type R<T>=T extends {make(value:string|number):infer U}?U:Error;type Failure=R<{make(value?:string):{stack:string}}>;function read(error:Failure){return error.stack;}',
    expected: true,
  },
  {
    name: 'optional-source-undefined-domain-data',
    source:
      'type R<T>=T extends {make(value:string|number):infer U}?U:{stack:string};type Failure=R<{make(value?:string):Error}>;function read(error:Failure){return error.stack;}',
    expected: false,
  },
  {
    name: 'optional target accepted explicit undefined',
    source:
      'type R<T>=T extends {make(value?:string):infer U}?U:Error;type Failure=R<{make(value:string|number|undefined):{stack:string}}>;function read(error:Failure){return error.stack;}',
    expected: false,
  },
  {
    name: 'optional source fits explicit undefined',
    source:
      'type R<T>=T extends {make(value:string|number|undefined):infer U}?U:Error;type Failure=R<{make(value?:string):{stack:string}}>;function read(error:Failure){return error.stack;}',
    expected: false,
  },
  {
    name: 'matching optional methods retain error',
    source:
      'type R<T>=T extends {make(value?:string):infer U}?U:never;type Failure=R<{make(value?:string):Error}>;function read(error:Failure){return error.stack;}',
    expected: true,
  },
  {
    name: 'bivariant required methods retain data',
    source:
      'type R<T>=T extends {make(value:string|number):infer U}?U:Error;type Failure=R<{make(value:string):{stack:string}}>;function read(error:Failure){return error.stack;}',
    expected: false,
  },
] as const;

describe('optional method argument domains', () => {
  it.each(CASES)('$name', ({ source, expected }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'method-optional.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(expected);
  });
});

describe('shared optional method inference', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES.slice(0, COUNTS.regressions))('$name', async ({ source, expected }) => {
    const app = await fixture(source);
    apps.push(app);
    const reasons = compile(app).refusals.map((refusal) => refusal.reason);
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const required = expected ? [sharedReason] : [];

    expect(reasons).toStrictEqual(required);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node)?.includes('reads `stack` of an error') === true) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

async function fixture(source: string): Promise<Application> {
  return application({
    'domain/method-optional.ts': `${source} export function label(value: string) {return value;}`,
    'components/method-optional.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/method-optional';",
      'export default function MethodOptional({projectId, first}: {projectId: string; first: string}) {',
      'const [selected, setSelected] = useReactiveState(first);',
      'return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;}',
    ].join('\n'),
  });
}
