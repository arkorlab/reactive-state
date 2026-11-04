import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const KEY_REFUSAL = expect.stringContaining("The key of a list's item");
const STATE_REFUSAL = expect.stringContaining('undefined');

/** An intersection requires a property if any constituent that declares it requires it. */
describe('intersection member optionality', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { type: 'Partial<Base> & {id:string}', taken: true },
    { type: '{id:string} & Partial<Base>', taken: true },
    { type: '{id?:string} & {id:string}', taken: true },
    { type: 'Readonly<Partial<Base>> & RequiredId', taken: true },
    { type: 'RequiredId & Readonly<Partial<Base>>', taken: true },
    { type: 'Partial<Base> & {other?:number} & RequiredId', taken: true },
    { type: 'Partial<Base> & {id?:string}', taken: false },
    { type: 'Partial<Base> & Readonly<Partial<Base>>', taken: false },
    { type: '{id?:string|undefined} & {id:string|undefined}', taken: false },
    { type: '{id?:string|null} & {id:string|null}', taken: false },
    { type: '{id?:string|number} & {id:string|number}', taken: true },
    { type: 'Partial<Base> & {label:string}', taken: false },
  ])('reads the required key of $type', async ({ type, taken }) => {
    const app = await fixture(type, 'key');
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual(
      taken ? [] : [KEY_REFUSAL],
    );
  });

  it.each([
    { type: 'Partial<Base> & {id:string}', taken: true },
    { type: '{id:string} & Partial<Base>', taken: true },
    { type: 'Readonly<Partial<Base>> & RequiredId', taken: true },
    { type: 'Partial<Base> & {id?:string}', taken: false },
  ])('reads the state member kind of $type', async ({ type, taken }) => {
    const app = await fixture(type, 'state');
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual(
      taken ? [] : [STATE_REFUSAL],
    );
  });
});

/** Both admission checks read the same imported member type through their production entry point. */
async function fixture(type: string, use: 'key' | 'state'): Promise<Application> {
  const initial = use === 'key' ? 'readonly Panel[]' : 'Panel';
  const state = use === 'key' ? 'first' : 'first.id';
  const render =
    use === 'key'
      ? '<>{selected.map(panel=><TodoCommands key={panel.id} projectId={projectId} id="t1"/>)}</>'
      : '<TodoCommands projectId={projectId} id={selected}/>';
  return application({
    'types/intersection-members.ts': [
      'interface Base {id:string}',
      'type RequiredId={id:string};',
      `export type Panel=${type};`,
    ].join('\n'),
    'components/intersection-members.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import type {Panel} from '@/types/intersection-members';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      `export default function IntersectionMembers({projectId,first}:{projectId:string;first:${initial}}){`,
      `const [selected,setSelected]=useReactiveState(${state});`,
      `return<section><button onClick={()=>setSelected(${state})}>reset</button>${render}</section>;}`,
    ].join('\n'),
  });
}
