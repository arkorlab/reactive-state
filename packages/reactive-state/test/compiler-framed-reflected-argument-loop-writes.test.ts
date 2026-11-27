import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A native called through `Reflect.apply` or `Reflect.construct` takes the arguments of its tuple at
 * the time of the call. A write to that tuple in a loop's condition or update runs before the next
 * pass's call, so a reader that answers for an exposed tuple by what was written into it (the text
 * of an error, a pattern, a body, a URL, a parameter, a map key) must see it, as it does for a write
 * before the call. A reader that drops its proof on an exposure keeps the narrower loop rule: a tuple
 * that a loop's condition only mentions still gives it the literal entries.
 */
const CASES = [
  {
    id: 'error-construct-condition-write',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.construct(Error,args) as Error).message;}while((args[0]=error as never,i++<1));return out;}",
    refused: true,
  },
  {
    id: 'error-construct-update-write',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;for(let i=0;i<2;args[0]=error as never,i++){out=(Reflect.construct(Error,args) as Error).message;}return out;}",
    refused: true,
  },
  {
    id: 'error-construct-body-write',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;for(let i=0;i<2;i++){out=(Reflect.construct(Error,args) as Error).message;args[0]=error as never;}return out;}",
    refused: true,
  },
  {
    id: 'error-construct-write-before',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];args[0]=error as never;return (Reflect.construct(Error,args) as Error).message;}",
    refused: true,
  },
  {
    id: 'error-apply-condition-write',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.apply(Error,undefined,args) as Error).message;}while((args[0]=error as never,i++<1));return out;}",
    refused: true,
  },
  {
    id: 'error-construct-condition-mention-data',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.construct(Error,args) as Error).message;}while((void args,i++<1));return out;}",
    refused: false,
  },
  {
    id: 'error-construct-condition-other-write-data',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.construct(Error,args) as Error).message;}while((error,i++<1));return out;}",
    refused: false,
  },
  {
    id: 'error-construct-untouched-data',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.construct(Error,args) as Error).message;}while(i++<1);return out;}",
    refused: false,
  },
  {
    id: 'regexp-construct-condition-write',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.construct(RegExp,args) as RegExp).source;}while((args[0]=error as never,i++<1));return out;}",
    refused: true,
  },
  {
    id: 'regexp-apply-condition-write',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.apply(RegExp,undefined,args) as RegExp).source;}while((args[0]=error as never,i++<1));return out;}",
    refused: true,
  },
  {
    id: 'regexp-construct-untouched-data',
    source:
      "function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=(Reflect.construct(RegExp,args) as RegExp).source;}while(i++<1);return out;}",
    refused: false,
  },
  {
    id: 'response-construct-condition-write',
    source:
      "async function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=await (Reflect.construct(Response,args) as Response).text();}while((args[0]=error as never,i++<1));return out;}",
    refused: true,
  },
  {
    id: 'response-construct-untouched-data',
    source:
      "async function frames(error:Error){const args:[string]=['fixed'];let out:unknown;let i=0;do{out=await (Reflect.construct(Response,args) as Response).text();}while(i++<1);return out;}",
    refused: false,
  },
  {
    id: 'url-parse-condition-write',
    source:
      "function frames(error:Error){const args:[string]=['http://example.test/'];let out:unknown;let i=0;do{out=(Reflect.apply(URL.parse,URL,args) as URL|null)?.href;}while((args[0]=error as never,i++<1));return out;}",
    refused: true,
  },
  {
    id: 'url-parse-untouched-data',
    source:
      "function frames(error:Error){const args:[string]=['http://example.test/'];let out:unknown;let i=0;do{out=(Reflect.apply(URL.parse,URL,args) as URL|null)?.href;}while(i++<1);return out;}",
    refused: false,
  },
  {
    id: 'parameters-append-condition-write',
    source:
      "function frames(error:Error){const params=new URLSearchParams();const args:[string,string]=['k','fixed'];let i=0;do{Reflect.apply(URLSearchParams.prototype.append,params,args);}while((args[1]=error as never,i++<1));return params.get('k');}",
    refused: true,
  },
  {
    id: 'parameters-append-untouched-data',
    source:
      "function frames(error:Error){const params=new URLSearchParams();const args:[string,string]=['k','fixed'];let i=0;do{Reflect.apply(URLSearchParams.prototype.append,params,args);}while(i++<1);return params.get('k');}",
    refused: false,
  },
  {
    id: 'map-get-key-condition-write',
    source:
      "function frames(error:Error){const map=new Map<string,unknown>([['a','fixed'],['b',error]]);const args:[string]=['a'];let out:unknown;let i=0;do{out=Reflect.apply(Map.prototype.get,map,args);}while((args[0]='b',i++<1));return (out as {stack?:string}).stack;}",
    refused: true,
  },
  // Not the tuple's rule: the Map is handed on to a borrowed `get` that a loop runs again, which the
  // iteration-writes reader takes for a use that may replace the Map's `get` (a borrowed `set` is the
  // one borrowed native it reads as quiet), so any entry may answer and the Error among them is read.
  {
    id: 'map-get-key-untouched-loop-handed-on',
    source:
      "function frames(error:Error){const map=new Map<string,unknown>([['a','fixed'],['b',error]]);const args:[string]=['a'];let out:unknown;let i=0;do{out=Reflect.apply(Map.prototype.get,map,args);}while(i++<1);return (out as {stack?:string}).stack;}",
    refused: true,
  },
  {
    id: 'blob-construct-condition-mention-refused',
    source:
      'async function frames(error:Error){const args:[Error[]]=[[error]];let out:unknown;let i=0;do{out=await (Reflect.construct(Blob,args) as Blob).text();}while((void args,i++<1));return out;}',
    refused: true,
  },
  {
    id: 'cause-construct-condition-mention-refused',
    source:
      "function frames(error:Error){const args:[string,{cause:Error}]=['m',{cause:error}];let out:unknown;let i=0;do{out=((Reflect.construct(Error,args) as Error).cause as {stack?:string}).stack;}while((void args,i++<1));return out;}",
    refused: true,
  },
] as const;

/**
 * A shared module that holds the `Error` or `URL` constructor is refused whatever it does with it, so
 * the rows that call one through Reflect are checked at the reader only.
 */
const HELD = ['error-', 'cause-', 'url-parse-'];
const COMPILED = CASES.filter((row) => HELD.every((prefix) => !row.id.startsWith(prefix)));

describe('natives called through Reflect under a write in a loop condition', () => {
  const { apps, compile } = compilerApplications();

  it.each(COMPILED)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        "export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error('ours'))).length>40?'all':value==='active'||value==='done'?value:'all';}",
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });

  it.each(CASES)('reads $id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflected-loop-writes.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});
