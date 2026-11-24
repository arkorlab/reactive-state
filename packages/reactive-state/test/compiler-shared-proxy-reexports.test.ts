import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Named re-exports select the external module, independent of same-spelled local declarations. */
describe('shared named re-export Proxy origins', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'function helper(input:string){return new Proxy({value:input},{});}export {helper} from "./reexport-target";',
    'function other(input:string){return new Proxy({value:input},{});}export {other as helper} from "./reexport-target";',
    'const helper=(input:string)=>new Proxy({value:input},{});export {helper} from "./reexport-target";',
    'const other=(input:string)=>new Proxy({value:input},{});export {other as helper} from "./reexport-target";',
  ])('keeps external re-exports despite an unrelated local Proxy origin: %s', async (domain) => {
    const app = await fixture(domain);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'function helper(value:string){return {value};}export {helper};',
    'function other(value:string){return {value};}export {other as helper};',
  ])('keeps ordinary locally named exports: %s', async (domain) => {
    const app = await fixture(domain);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'export {helper} from "./reexport-target";',
    'export {other as helper} from "./reexport-target";',
  ])('refuses a Proxy returned by the actual external module: %s', async (domain) => {
    const app = await fixture(
      domain,
      'export function helper(value:string){return new Proxy({value},{});}export function other(value:string){return new Proxy({value},{});}',
    );
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('Proxy'),
    ]);
  });
});

/** The helper result is an intermediate of a dynamic site's string-valued prop. */
async function fixture(
  domain: string,
  target = 'export function helper(value:string){return {value};}export function other(value:string){return {value};}',
): Promise<Application> {
  return application({
    'domain/proxy-intermediate.ts': domain,
    'domain/reexport-target.ts': target,
    'components/proxy-intermediate.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {helper} from '@/domain/proxy-intermediate';",
      'export default function ProxyIntermediate({projectId,first}:{projectId:string;first:string}){',
      'const [text,setText]=useReactiveState<string>(first);',
      [
        "return<section><button onClick={()=>setText('next')}>next</button><TodoCommands projectId={projectId} id={",
        'helper(text).value',
        '}/></section>;}',
      ].join(''),
    ].join('\n'),
  });
}
