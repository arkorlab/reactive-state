import { describe, expect, it } from 'vitest';

import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { firstIn, untrackedAt } from '../src/compiler/untracked-reads.ts';
import { application, output } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Bound native Intl formatter calls keep clock inputs and original evaluation guards. */
const CASES = [
  {
    id: 'reported-inline-bind',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
  {
    id: 'saved-bound-method',
    source:
      "export function Widget(){const read=Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}));return <p>{JSON.stringify(read())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){const read=Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}));return read();}",
  },
  {
    id: 'whole-bound-alias',
    source:
      "export function Widget(){const first=Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}));const read=first;return <p>{JSON.stringify(read())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){const first=Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}));const read=first;return read();}",
  },
  {
    id: 'whole-native-method-alias',
    source:
      "export function Widget(){const read=Intl.DateTimeFormat.prototype.formatToParts;return <p>{JSON.stringify(read.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){const read=Intl.DateTimeFormat.prototype.formatToParts;return read.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
  {
    id: 'whole-native-prototype-alias',
    source:
      "export function Widget(){const proto=Intl.DateTimeFormat.prototype;return <p>{JSON.stringify(proto.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){const proto=Intl.DateTimeFormat.prototype;return proto.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
  {
    id: 'literal-bracket-bind',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts[\"bind\"](new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts[\"bind\"](new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
  {
    id: 'empty-bind-spread',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),...([] as const))())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),...([] as const))();}",
  },
  {
    id: 'bound-undefined',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined)())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined)();}",
  },
  {
    id: 'bound-void',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),void 0)())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),void 0)();}",
  },
  {
    id: 'bound-undefined-alias',
    source:
      "export function Widget(){const date=undefined;return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),date)())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){const date=undefined;return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),date)();}",
  },
  {
    id: 'bound-literal-spread',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(...([new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined] as const))())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(...([new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined] as const))();}",
  },
  {
    id: 'invoked-undefined',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(undefined))}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(undefined);}",
  },
  {
    id: 'bound-undefined-wins-over-invocation',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined)(0))}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined)(0);}",
  },
  {
    id: 'fresh-saved-receiver',
    source:
      "export function Widget(){const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'});return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(formatter)())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'});return Intl.DateTimeFormat.prototype.formatToParts.bind(formatter)();}",
  },
  {
    id: 'bind-does-not-format',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'})))}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}));}",
  },
  {
    id: 'bound-zero-is-fixed',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),0)())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),0)();}",
  },
  {
    id: 'bound-null-is-fixed',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),null)())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),null)();}",
  },
  {
    id: 'invoked-zero-is-fixed',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(0))}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(0);}",
  },
  {
    id: 'bound-zero-wins-over-undefined',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),0)(undefined))}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),0)(undefined);}",
  },
  {
    id: 'ordinary-function-bind',
    source:
      'export function Widget(){const read=()=>[{type:"literal",value:"fixed"}];return <p>{JSON.stringify(read.bind(null)())}</p>;}',
    input: false,
    private: false,
    runtime:
      'function probe(){const read=()=>[{type:"literal",value:"fixed"}];return read.bind(null)();}',
  },
  {
    id: 'wrong-native-brand',
    source:
      'export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.NumberFormat("en-US"))())}</p>;}',
    input: false,
    private: false,
    runtime:
      'function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.NumberFormat("en-US"))();}',
  },
  {
    id: 'bound-ignored-effect-tail',
    source:
      "export function Widget(){function touch(){return 0;}return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined,touch())())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){function touch(){return 0;}return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined,touch())();}",
  },
  {
    id: 'invocation-ignored-effect-tail',
    source:
      "export function Widget(){function touch(){return 0;}return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(undefined,touch()))}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){function touch(){return 0;}return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(undefined,touch());}",
  },
  {
    id: 'earlier-opaque-work',
    source:
      "export function Widget(){function touch(){return 0;}touch();return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){function touch(){return 0;}touch();return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
  {
    id: 'whole-exposed-receiver',
    source:
      "export function Widget(){const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'});function touch(value:unknown){return value;}touch(formatter);return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(formatter)())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'});function touch(value:unknown){return value;}touch(formatter);return Intl.DateTimeFormat.prototype.formatToParts.bind(formatter)();}",
  },
  {
    id: 'own-wrapper-method',
    source:
      "export function Widget(){const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'});formatter.formatToParts=()=>[];return <p>{JSON.stringify(formatter.formatToParts.bind(formatter)())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'});formatter.formatToParts=()=>[];return formatter.formatToParts.bind(formatter)();}",
  },
  {
    id: 'cross-owner-bound',
    source:
      "const read=Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}));export function Widget(){return <p>{JSON.stringify(read())}</p>;}",
    input: false,
    private: false,
    runtime: null,
  },
  {
    id: 'event-body-only',
    source:
      "export function Widget(){return <button onClick={()=>Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))()}>fixed</button>;}",
    input: null,
    private: false,
    runtime: null,
  },
  {
    id: 'effect-body-only',
    source:
      "import {useEffect} from \"react\";export function Widget(){useEffect(()=>{Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))()},[]);return <p>fixed</p>;}",
    input: null,
    private: false,
    runtime: null,
  },
  {
    id: 'quiet-ignored-bound-tail',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined,0)())}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}),undefined,0)();}",
  },
  {
    id: 'quiet-ignored-invocation-tail',
    source:
      "export function Widget(){return <p>{JSON.stringify(Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(undefined,0))}</p>;}",
    input: true,
    private: true,
    runtime:
      "function probe(){return Intl.DateTimeFormat.prototype.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))(undefined,0);}",
  },
  {
    id: 'exposed-prototype-alias',
    source:
      "export function Widget(){const proto=Intl.DateTimeFormat.prototype;function touch(value:unknown){return value;}touch(proto);return <p>{JSON.stringify(proto.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){const proto=Intl.DateTimeFormat.prototype;function touch(value:unknown){return value;}touch(proto);return proto.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
  {
    id: 'replaced-native-method-bind',
    source:
      "export function Widget(){const read=Intl.DateTimeFormat.prototype.formatToParts;Object.defineProperty(read,\"bind\",{value:()=>()=>[]});return <p>{JSON.stringify(read.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){const read=Intl.DateTimeFormat.prototype.formatToParts;Object.defineProperty(read,\"bind\",{value:()=>()=>[]});return read.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
  {
    id: 'replaced-prototype-method-bind',
    source:
      "export function Widget(){const proto=Intl.DateTimeFormat.prototype;Object.defineProperty(proto.formatToParts,\"bind\",{value:()=>()=>[]});return <p>{JSON.stringify(proto.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))())}</p>;}",
    input: false,
    private: false,
    runtime:
      "function probe(){const proto=Intl.DateTimeFormat.prototype;Object.defineProperty(proto.formatToParts,\"bind\",{value:()=>()=>[]});return proto.formatToParts.bind(new Intl.DateTimeFormat('en-US',{timeZone:'UTC',timeStyle:'medium'}))();}",
  },
] as const;

describe('bound Intl formatter clock readers', () => {
  it.each(CASES.filter((row) => row.input !== null))('$id', ({ source, input }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'bound-intl-clock.tsx', source);
    const read = firstIn([parsed.sourceFile], untrackedAt, () => false);

    expect(read !== undefined).toBe(input);
  });
});

describe('bound Intl formatter clock route renders', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, private: privateRender }) => {
    const app = await application({
      'controls/widget.tsx': `'use client';\n${source}`,
      'app/boards/layout.tsx': [
        "import type {ReactNode} from 'react';",
        "import {Widget} from '@/controls/widget';",
        'export default function Layout({children}:{children:ReactNode}){return <section><Widget/>{children}</section>;}',
      ].join('\n'),
    });
    apps.push(app);
    const compiled = compile(app);
    const manifest = JSON.parse(output(compiled, app, 'manifest.json')) as {
      routes: { route: string; shared: boolean; private?: string }[];
    };
    const board = manifest.routes.find((entry) => entry.route === '/boards/[projectId]');
    const found = {
      refusals: compiled.refusals,
      shared: board?.shared,
      private: board?.private !== undefined,
    };
    const expected = { refusals: [], shared: !privateRender, private: privateRender };

    expect(found).toStrictEqual(expected);
  });
});
