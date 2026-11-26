import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Shared helpers cannot expose Proxy internals to intermediate-value measurement. */
describe('shared Proxy intermediate values', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'export function helper(input:string){return new Proxy({value:input},{ownKeys(){throw new Error("unused");}});}',
    'export function helper(input:string){return Proxy.revocable({value:input},{getOwnPropertyDescriptor(){throw new Error("unused");}}).proxy;}',
    'const Wrap=Proxy;export function helper(input:string){return new Wrap({value:input},{});}',
    'export function helper(input:string){return new globalThis.Proxy({value:input},{});}',
    'const carrier=new Proxy({value:"fixed"},{getPrototypeOf(){throw new Error("unused");}});export function helper(_input:string){return carrier;}',
    'export function helper(input:string){return new Proxy({value:input},{});}',
  ])('refuses the shared Proxy source before evaluating its intermediate: %s', async (domain) => {
    const app = await fixture(domain);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('Proxy'),
    ]);
  });

  it('refuses the previously runtime-guarded native method carried through a Proxy', async () => {
    const domain = [
      "const carrier = new Proxy({ toString() { return 'x'; } }, { get(target, key) { return key === 'padStart' ? ''.padStart : Reflect.get(target, key); } });",
      'export function helper(){return carrier;}',
    ].join('\n');
    const app = await fixture(domain, 'helper().padStart(20,text)');
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('Proxy'),
    ]);
  });

  it.each([
    'export function helper(input:string){return {value:input};}',
    'export function helper(input:string){return {get value(){return input;}};}',
    'function Proxy<T>(value:T):T{return value;}export function helper(input:string){return Proxy({value:input});}',
    'export function helper(input:string){const value=new Proxy({toString(){return input;}},{});return {value:String(value)};}',
    'export function helper(input:string){return {value:typeof Proxy+input};}',
    'export function helper(input:string){return {value:typeof Proxy.revocable+input};}',
    'export function helper(input:string){return {value:typeof globalThis["Proxy"]["revocable"]+input};}',
  ])(
    'keeps ordinary values, explicit getters, lexical names and harmless type tests: %s',
    async (domain) => {
      const app = await fixture(domain);
      apps.push(app);

      expect(compile(app).refusals).toStrictEqual([]);
    },
  );
});

/** The helper result is an intermediate of a dynamic site's string-valued prop. */
async function fixture(domain: string, expression = 'helper(text).value'): Promise<Application> {
  return application({
    'domain/proxy-intermediate.ts': domain,
    'components/proxy-intermediate.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {helper} from '@/domain/proxy-intermediate';",
      'export default function ProxyIntermediate({projectId,first}:{projectId:string;first:string}){',
      'const [text,setText]=useReactiveState<string>(first);',
      [
        "return<section><button onClick={()=>setText('next')}>next</button><TodoCommands projectId={projectId} id={",
        expression,
        '}/></section>;}',
      ].join(''),
    ].join('\n'),
  });
}
