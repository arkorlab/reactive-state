import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A constructor parameter's default, and a binding element's on the way to a destructured name,
 * stand for what the construction leaves `undefined`, with the parameters they read.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly native: string;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'reflected-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return Reflect.construct(Failure,[{message:error}]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'nested-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=(fallback as{inner:{message:unknown}}).inner){super(options.message as never);}}function frames(error:Error){return new Failure({inner:{message:error}}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'chained-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,first=fallback as{message:unknown},options=first){super(options.message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'destructured-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,{message}=fallback as{message:unknown}){super(message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'nested-binding-default',
    source:
      'class Failure extends Error{constructor(fallback:unknown,{inner:{message}=fallback as{message:unknown}}:{inner?:{message:unknown}}={}){super(message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'array-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as readonly{message:unknown}[]){super(options[0]!.message as never);}}function frames(error:Error){return new Failure([{message:error}]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'computed-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options["message"]as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'aggregate-default-field',
    source:
      'class Failure extends AggregateError{constructor(fallback:unknown,options=fallback as{message:unknown}){super([],options.message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'dom-message-default-field',
    source:
      'class Failure extends DOMException{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'dom-name-default-field',
    source:
      'class Failure extends DOMException{constructor(fallback:unknown,options=fallback as{name:unknown}){super("fixed",options.name as never);}}function frames(error:Error){return new Failure({name:error}).name;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error',
  },
  {
    id: 'getter-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({get message(){return error;}}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'array-word-default-field',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:[error]}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'selected-array-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as readonly unknown[]){super(options[1]as never);}}function frames(error:Error){return new Failure([error,"fixed"]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'selected-object-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:"fixed",other:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'selected-nested-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=(fallback as{inner:{message:unknown}}).inner){super(options.message as never);}}function frames(error:Error){return new Failure({inner:{message:"fixed",other:error}}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'local-error-words',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:new Error("local")}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'Error: local',
  },
  {
    id: 'provided-options-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:error},{message:"fixed"}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'provided-pattern-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,{message}=fallback as{message:unknown}){super(message as never);}}function frames(error:Error){return new Failure({message:error},{message:"fixed"}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'provided-binding-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,{message=fallback as{message:unknown}}:{message?:{message:unknown}}={}){super(message.message as never);}}function frames(error:Error){return new Failure({message:error},{message:{message:"fixed"}}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'fixed-outer-pattern-default',
    source:
      'class Failure extends Error{constructor(fallback:unknown,{message=fallback as{message:unknown}}:{message?:{message:unknown}}={message:{message:"fixed"}}){super(message.message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'direct-provided-field',
    source:
      'class Failure extends Error{constructor(options:{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'literal-super-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super("fixed");}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'omitted-argument-undefined',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:error},undefined).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'local-error-shadow',
    source:
      'class Error{message="fixed";constructor(_value?:unknown){}}class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'own-error-conversion-data',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'ignored-tail-rewrite',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){const Make=Failure as new(...args:unknown[])=>Failure;return new Make({message:error},undefined,Object.defineProperty(error,"toString",{value:()=>"fixed"})).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'unused-default-callback-bridge',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown},prepare?:()=>unknown,_ignored=prepare!()){super(options.message as never);}}function frames(error:Error){function collect(value:Error,prepare:()=>unknown){return new Failure({message:value},undefined,prepare).message;}return collect(error,()=>Object.defineProperty(error,"toString",{value:()=>"fixed"}));}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'unused-default-getter-bridge',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown},settings?:{fix:unknown},_ignored=settings!.fix){super(options.message as never);}}function frames(error:Error){function collect(value:Error,settings:{fix:unknown}){return new Failure({message:value},undefined,settings).message;}return collect(error,{get fix(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return 0;}});}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'unknown-prefix-bridge',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){function collect(value:Error,prepare:()=>void){prepare();return new Failure({message:value}).message;}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'reflected-new-target-rewrite',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){const target=new Proxy(function(){},{get(value,key,receiver){if(key==="prototype"){Object.defineProperty(error,"toString",{value:()=>"fixed"});}return Reflect.get(value,key,receiver);}});return (Reflect.construct(Failure,[{message:error}],target)as Error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'quiet-ignored-tail',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){const Make=Failure as new(...args:unknown[])=>Failure;return new Make({message:error},undefined,0).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'compound-object-default',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options={message:fallback}){super(options.message as never);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'compound-call-default',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=String(fallback)){super(options);}}function frames(error:Error){return new Failure(error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'unknown-key-default',
    source:
      'class Failure extends Error{constructor(fallback:unknown,key:string,options=fallback as Record<string,unknown>){super(options[key]as never);}}function frames(error:Error){return new Failure({message:error},"message").message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'unused-default-conversion-bridge',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown},input?:unknown,_ignored=+(input as never)){super(options.message as never);}}function frames(error:Error){function collect(value:Error,input:unknown){return new Failure({message:value},undefined,input).message;}return collect(error,{valueOf(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return 0;}});}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'ignored-super-tail-bridge',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown},prepare?:()=>unknown){super(options.message as never,prepare!()as ErrorOptions);}}function frames(error:Error){function collect(value:Error,prepare:()=>unknown){return new Failure({message:value},undefined,prepare).message;}return collect(error,()=>Object.defineProperty(error,"toString",{value:()=>"fixed"}));}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
  {
    id: 'quiet-super-options',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never,{cause:0});}}function frames(error:Error){return new Failure({message:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'Error: supplied',
  },
  {
    id: 'bound-construction-tail-bridge',
    source:
      'class Failure extends Error{constructor(fallback:unknown,options=fallback as{message:unknown}){super(options.message as never);}}function frames(error:Error){function collect(value:Error,prepare:()=>unknown){const Make=Failure as new(...args:unknown[])=>Failure;return new (Make.bind(null,{message:value},undefined,prepare()))().message;}return collect(error,()=>Object.defineProperty(error,"toString",{value:()=>"fixed"}));}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    native: 'fixed',
  },
];

describe('constructor default path readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'constructor-default-paths.ts', source);
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

describe('shared constructor default path admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
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
