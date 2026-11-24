import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source arguments keep their original scope through rest binding and literal tuple spreading. */
describe('proxy origins through source arguments', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'function choose(...xs:any[]){return xs[0];}export function helper(text:string){return choose(new Proxy({value:text},{}));}',
    'function choose(_ignored:unknown,...xs:any[]){return xs[1];}export function helper(text:string){return choose(text,{value:text},new Proxy({value:text},{}));}',
    'function choose(value:any){return value;}export function helper(text:string){return choose(...[new Proxy({value:text},{})]);}',
    'function choose(_ignored:unknown,value:any){return value;}export function helper(text:string){return choose(...[text,new Proxy({value:text},{})]);}',
    'function choose(...xs:any[]){return xs[0];}export function helper(text:string){return choose(...[new Proxy({value:text},{})]);}',
    'function choose(value:any){return value;}export function helper(text:string){const tuple=[new Proxy({value:text},{})] as const;return choose(...tuple);}',
    'function choose(...xs:any[]){return xs[0];}function relay(...values:any[]){return choose(...values);}export function helper(text:string){return relay(new Proxy({value:text},{}));}',
    'function collect(...xs:any[]){return xs;}export function helper(text:string){return collect(new Proxy({value:text},{}));}',
  ])('refuses a Proxy forwarded through the selected argument: %s', async (domain) => {
    const app = await fixture(domain);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('Proxy'),
    ]);
  });

  it.each([
    'function choose(...xs:any[]){xs[0]={value:"safe"};return xs[0];}export function helper(text:string){return choose(new Proxy({value:text},{}));}',
    'function repair(values:any[]){values[0]={value:"safe"};}function choose(...xs:any[]){repair(xs);return xs[0];}export function helper(text:string){return choose(new Proxy({value:text},{}));}',
  ])('refuses a Proxy handed to a rest array the code writes a place of: %s', async (domain) => {
    const app = await fixture(domain);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('Proxy'),
    ]);
  });

  it.each([
    'function choose(...xs:any[]){return xs[0];}export function helper(text:string){return choose({value:text},new Proxy({},{}));}',
    'function choose(value:any){return value;}export function helper(text:string){return choose(...[{value:text},new Proxy({},{})]);}',
    'function count(...xs:any[]){return xs.length;}export function helper(text:string){return {value:String(count(new Proxy({},{})))};}',
    'function choose(value:any){return value;}export function helper(text:string){const values=[new Proxy({value:text},{})];values[0]={value:text};return choose(...values);}',
    'function choose(value:any){return value;}export function helper(text:string){const values=[new Proxy({value:text},{})];const alias=values;alias[0]={value:text};return choose(...values);}',
    'function choose(_ignored:any,value:any){return value;}export function helper(text:string){const values=text.split("").map(value=>({value}));return choose(...values,new Proxy({value:text},{}));}',
    'function choose(...xs:any[]){return xs[0];}export function helper(text:string){return {value:String(choose(...[new Proxy({toString(){return text;}},{})]))};}',
    'function choose(...xs:any[]){return xs[0].value;}export function helper(text:string){return {value:choose({value:text},new Proxy({},{}))};}',
  ])('keeps selected ordinary values, changed tuples and unknown spreads: %s', async (domain) => {
    const app = await fixture(domain);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared helper's returned carrier is measured before the dynamic site reads its value. */
async function fixture(domain: string): Promise<Application> {
  return application({
    'domain/proxy-arguments.ts': domain,
    'components/proxy-arguments.reactive.tsx': [
      "import {useReactiveState} from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import {helper} from '@/domain/proxy-arguments';",
      'export default function ProxyArguments({projectId,first}:{projectId:string;first:string}){',
      'const [text,setText]=useReactiveState<string>(first);',
      'return<section><button onClick={()=>setText(first)}>reset</button><TodoCommands projectId={projectId} id={helper(text).value}/></section>;}',
    ].join('\n'),
  });
}
