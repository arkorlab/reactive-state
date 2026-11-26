import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Exported object members inherit from literal prototypes only after all own entries are read. */
describe('exported literal prototype members', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { module: 'export const payload={__proto__:{held:new Date(0)}};', read: 'payload.held' },
    {
      module: 'const base={held:Symbol("value")};export const payload={__proto__:base};',
      read: 'payload.held',
    },
    { module: 'export const payload={__proto__:{held:()=>0}};', read: 'payload.held' },
    {
      module: 'export const payload={__proto__:{held(){return new Date(0);}}};',
      read: 'payload.held()',
    },
    {
      module: 'export const payload={__proto__:{get held(){return new Date(0);}}};',
      read: 'payload.held',
    },
    {
      module: 'export const payload={__proto__:{__proto__:{held:new Date(0)}}};',
      read: 'payload.held',
    },
    { module: 'export const payload={"__proto__":{held:new Date(0)}};', read: 'payload.held' },
    {
      module:
        'import {base} from "./exported-prototype-base";export const payload={__proto__:base};',
      read: 'payload.held',
    },
  ])('refuses an inherited non-JSON read or call: $module', async (row) => {
    const app = await fixture(row);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    {
      module: 'export const payload={held:"safe",__proto__:{held:new Date(0)}};',
      read: 'payload.held',
    },
    {
      module: 'export const payload={__proto__:{held:new Date(0)},held:"safe"};',
      read: 'payload.held',
    },
    { module: 'export const payload={__proto__:{held:"safe"}};', read: 'payload.held' },
    { module: 'export const payload={__proto__:null,held:"safe"};', read: 'payload.held' },
    { module: 'export const payload={__proto__:1,held:"safe"};', read: 'payload.held' },
    {
      module:
        'const source={__proto__:{held:new Date(0)}};export const payload={held:"safe",...source};',
      read: 'payload.held',
    },
    {
      module: 'function base(){return {held:"safe"};}export const payload={__proto__:base()};',
      read: 'payload.held',
    },
    {
      module:
        'const base:{held:unknown}={held:new Date(0)};export const payload={__proto__:base};base.held="safe";',
      read: 'payload.held',
    },
    {
      module: 'export const payload={__proto__:{held:new Date(0)}};payload.held="safe";',
      read: 'payload.held',
    },
    {
      module: 'export const payload={["__proto__"]:{held:new Date(0)},held:"safe"};',
      read: 'payload.held',
    },
    { module: 'export const payload={__proto__(){return "safe";}};', read: 'payload.__proto__()' },
    {
      module:
        'export const payload={__proto__:{held:new Date(0)},get held(){return "safe";},set held(value:string){void value;}};',
      read: 'payload.held',
    },
  ])(
    'keeps own shadows, own-only spreads and unknown or changed prototypes: $module',
    async (row) => {
      const app = await fixture(row);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});

/** The inherited member is checked as an imported authority initializer, before any output uses it. */
async function fixture(row: {
  readonly module: string;
  readonly read: string;
}): Promise<Application> {
  return application({
    'domain/exported-prototype-base.ts': 'export const base={held:new Date(0)};',
    'domain/exported-prototypes.ts': row.module,
    'components/exported-prototypes.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import {payload} from '@/domain/exported-prototypes';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      'export default function ExportedPrototypes({projectId,first}:{projectId:string;first:string}){',
      `const [selected,setSelected]=useReactiveState<string>(first===''?${row.read} as never:first);`,
      'return<section><button onClick={()=>setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={selected}/></section>;}',
    ].join('\n'),
  });
}
