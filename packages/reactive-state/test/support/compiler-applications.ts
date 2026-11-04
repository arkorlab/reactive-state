import type { API } from 'typescript/sync';
import { afterAll, beforeAll } from 'vitest';

import { openTypeScript } from '../../src/compiler/index.ts';
import { application, type Application, compiledApp, removed } from '../fixtures/application.ts';

const CLEANUP = { batch: 4 } as const;

/** Each suite opens its compiler once and removes every application after its tests finish. */
export function compilerApplications(): {
  readonly apps: Application[];
  readonly compile: (app: Application) => ReturnType<typeof compiledApp>;
} {
  let api: API;
  const apps: Application[] = [];

  // eslint-disable-next-line vitest/require-top-level-describe -- The caller registers this hook in its existing suite.
  beforeAll(() => {
    api = openTypeScript();
  });

  // eslint-disable-next-line vitest/require-top-level-describe -- The caller registers this hook in its existing suite.
  afterAll(async () => {
    api[Symbol.dispose]();
    for (let index = 0; index < apps.length; index += CLEANUP.batch) {
      await Promise.all(apps.slice(index, index + CLEANUP.batch).map(async (app) => removed(app)));
    }
  });

  return {
    apps,
    compile: (app) => compiledApp(app, api),
  };
}

type StateFixtureStyle = 'compact' | 'spaced' | 'indented' | 'ok' | 'value' | 'parenthesized';

/** The existing source layouts stay exact, including whitespace and discarded result syntax. */
function stateSource(name: string, expression: string, style: StateFixtureStyle): string {
  if (style === 'compact' || style === 'parenthesized') {
    const discarded = style === 'parenthesized' ? `(${expression})` : expression;
    return [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      `export default function ${name}({projectId,first}:{projectId:string;first:string}){`,
      `const [selected,setSelected]=useReactiveState<string>(first===''?(${discarded},'ok'):first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n');
  }
  const indent = style === 'spaced' ? '' : '  ';
  const value = style === 'value' ? 'value' : 'selected';
  const setter = style === 'value' ? 'setValue' : 'setSelected';
  const answer = style === 'spaced' || style === 'indented' ? 'first' : "'ok'";
  const commands = '<TodoCommands projectId={projectId}';
  return [
    "import { useReactiveState } from 'framework/react';",
    "import TodoCommands from '@/components/todo-commands.reactive';",
    `export default function ${name}({projectId, first}: {projectId: string; first: string}) {`,
    `${indent}const [${value}, ${setter}] = useReactiveState<string>(first === '' ? (${expression}, ${answer}) : first);`,
    `${indent}return <section><button onClick={() => ${setter}(first)}>reset</button>${commands} id={${value}} /></section>;`,
    '}',
  ].join('\n');
}

/** Creates the same application when the suite calls its original expression fixture. */
export function stateFixture(
  file: string,
  name: string,
  style: StateFixtureStyle = 'compact',
): (expression: string) => Promise<Application> {
  return async (expression) =>
    application({ [`components/${file}.reactive.tsx`]: stateSource(name, expression, style) });
}
