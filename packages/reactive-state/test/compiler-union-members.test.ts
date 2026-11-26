import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const KEY_REFUSAL = expect.stringContaining("The key of a list's item");

/** Every possible union member contributes to the declared type of a list key. */
describe('union-typed list item members', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    { type: '{id:string}|{id?:string;pending:true}', key: 'panel.id', taken: false },
    { type: '{id?:string;pending:true}|{id:string}', key: 'panel.id', taken: false },
    { type: '{id?:string}|{id?:number}', key: 'panel.id', taken: false },
    { type: '{id:string}|{id:string|null}', key: 'panel.id', taken: false },
    { type: '{id:string}|{id:boolean}', key: 'panel.id', taken: false },
    { type: '{id:string}|{id:{value:string}}', key: 'panel.id', taken: false },
    { type: 'Ready|Pending', key: 'panel.id', taken: false },
    { type: '{group:{id:string}}|{group:{id?:string}}', key: 'panel.group.id', taken: false },
    { type: '{id:string}|{id:boolean}', key: 'panel.id??"fallback"', taken: false },
    { type: '{id:string}|{id:string;pending:true}', key: 'panel.id', taken: true },
    { type: '{id:string}|{id:number}', key: 'panel.id', taken: true },
    { type: 'Readonly<Ready>|Ready', key: 'panel.id', taken: true },
    { type: 'Ready|Pending', key: 'panel.id??"fallback"', taken: true },
    { type: 'Ready|Pending', key: 'panel.id!', taken: true },
    { type: '{group:{id:string}}|{group:{id:number}}', key: 'panel.group.id', taken: true },
    { type: 'Partial<Ready>|Readonly<Ready>', key: 'panel.id||"fallback"', taken: true },
    { type: 'ExternalReady|ExternalPending', key: 'panel.id', taken: false },
    { type: 'ExternalReady|ExternalNumber', key: 'panel.id', taken: true },
    { type: '{group?:{id:string}}|{group:{id:number}}', key: 'panel.group!.id', taken: true },
  ])('checks $key on $type', async ({ type, key, taken }) => {
    const app = await application({
      'types/union-members.ts': [
        "import type {ExternalReady} from '@/types/union-ready';",
        "import type {ExternalPending,ExternalNumber} from '@/types/union-other';",
        'interface Ready{id:string}',
        'interface Pending{id?:string;pending:true}',
        `export type Panel=${type};`,
      ].join('\n'),
      'types/union-ready.ts': 'type Id=string;export interface ExternalReady{id:Id}',
      'types/union-other.ts':
        'type Id=boolean;export interface ExternalPending{id:Id}export interface ExternalNumber{id:number}',
      'components/union-members.reactive.tsx': [
        "import {useReactiveState} from 'framework/react';",
        "import type {Panel} from '@/types/union-members';",
        "import TodoCommands from '@/components/todo-commands.reactive';",
        'export default function UnionMembers({projectId,first}:{projectId:string;first:readonly Panel[]}){',
        'const [selected,setSelected]=useReactiveState(first);',
        'return<section><button onClick={()=>setSelected(first)}>reset</button>{selected.map(panel=><TodoCommands',
        `key={${key}}`,
        'projectId={projectId} id="t1"/>)}</section>;}',
      ].join('\n'),
    });
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual(
      taken ? [] : [KEY_REFUSAL],
    );
  });
});
