import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written interface signatures retain native instance and argument utility selections. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'instance-interface-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(): Error}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-interface-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(): FixedError}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'instance-generic-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T>{new(): T}type Failure=InstanceType<Maker<Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-generic-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T>{new(): T}type Failure=InstanceType<Maker<FixedError>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'instance-default-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T=Error>{new(): T}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-inherited-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Base<T>{new(): T}interface Maker extends Base<Error>{}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-last-overload-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(): FixedError;new(): Error}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-last-overload-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(): Error;new(): FixedError}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'instance-last-merged-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(): FixedError}interface Maker{new(): Error}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'instance-last-merged-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(): Error}interface Maker{new(): FixedError}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-interface-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{(value:Error):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-interface-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{(value:FixedError):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-generic-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T>{(value:T):unknown}type Failure=Parameters<Maker<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-generic-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T>{(value:T):unknown}type Failure=Parameters<Maker<FixedError>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-default-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T=Error>{(value:T):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-inherited-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Base<T>{(value:T):unknown}interface Maker extends Base<Error>{}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-last-overload-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{(value:FixedError):unknown;(value:Error):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-last-overload-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{(value:Error):unknown;(value:FixedError):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-last-merged-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{(value:FixedError):unknown}interface Maker{(value:Error):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-last-merged-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{(value:Error):unknown}interface Maker{(value:FixedError):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-interface-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(value:Error):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-interface-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(value:FixedError):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-generic-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T>{new(value:T):unknown}type Failure=ConstructorParameters<Maker<Error>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-generic-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T>{new(value:T):unknown}type Failure=ConstructorParameters<Maker<FixedError>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-default-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<T=Error>{new(value:T):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-inherited-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Base<T>{new(value:T):unknown}interface Maker extends Base<Error>{}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-last-overload-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(value:FixedError):unknown;new(value:Error):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-last-overload-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(value:Error):unknown;new(value:FixedError):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-last-merged-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(value:FixedError):unknown}interface Maker{new(value:Error):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-last-merged-fixederror',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(value:Error):unknown}interface Maker{new(value:FixedError):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'instance-inherited-last-signature-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Base{new():Error}interface Maker extends Base{new():FixedError}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-inherited-last-signature-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Base{(value:FixedError):void}interface Maker extends Base{(value:Error):void}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-inherited-last-signature-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Base{new(value:FixedError):unknown}interface Maker extends Base{new(value:Error):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'instance-call-signature-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{():Error;new():FixedError}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-construct-signature-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{new(value:Error):unknown;(value:FixedError):void}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-call-signature-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{(value:Error):void;new(value:FixedError):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'instance-native-utility-shadow-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type InstanceType<T>=FixedError;interface Maker{new():Error}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'instance-opaque-inherited-data-pin',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new():Error}type Failure=InstanceType<Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new():FixedError}',
    },
  },
  {
    id: 'call-opaque-inherited-data-pin',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{(value:Error):unknown}type Failure=Parameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{(value:FixedError):unknown}',
    },
  },
  {
    id: 'construct-opaque-inherited-data-pin',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new(value:Error):unknown}type Failure=ConstructorParameters<Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new(value:FixedError):unknown}',
    },
  },
  {
    id: 'instance-opaque-right-known-error',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new():Error}type Failure=InstanceType<Maker & {new():Error}>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new():Error}',
    },
  },
  {
    id: 'instance-opaque-left-known-error',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new():Error}type Failure=InstanceType<{new():Error} & Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new():Error}',
    },
  },
  {
    id: 'instance-opaque-left-known-interface-data',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new():Error}interface Known{new():Error}type Failure=InstanceType<Known & Maker>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new():FixedError}',
    },
  },
  {
    id: 'call-opaque-right-known-error',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{(value:Error):unknown}type Failure=Parameters<Maker & {(value:Error):unknown}>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{(value:Error):unknown}',
    },
  },
  {
    id: 'call-opaque-left-known-error',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{(value:Error):unknown}type Failure=Parameters<{(value:Error):unknown} & Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{(value:Error):unknown}',
    },
  },
  {
    id: 'call-opaque-left-known-interface-data',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{(value:Error):unknown}interface Known{(value:Error):unknown}type Failure=Parameters<Known & Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{(value:FixedError):unknown}',
    },
  },
  {
    id: 'construct-opaque-right-known-error',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new(value:Error):unknown}type Failure=ConstructorParameters<Maker & {new(value:Error):unknown}>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new(value:Error):unknown}',
    },
  },
  {
    id: 'construct-opaque-left-known-error',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new(value:Error):unknown}type Failure=ConstructorParameters<{new(value:Error):unknown} & Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new(value:Error):unknown}',
    },
  },
  {
    id: 'construct-opaque-left-known-interface-data',
    source:
      'type Base=import("./external.js").Base;interface Maker extends Base{new(value:Error):unknown}interface Known{new(value:Error):unknown}type Failure=ConstructorParameters<Known & Maker>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts':
        'type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};export interface Base{new(value:FixedError):unknown}',
    },
  },
];

describe('interface utility signature readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'interface-utility-signatures.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared interface utility signature admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
