import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * Native abort replaces a source-known quiet undefined reason with its default DOMException.
 * First-reason, argument evaluation and source-written exposure boundaries remain intact.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly retainedShape?: boolean;
  readonly native: string | boolean;
  readonly nativeMode: string;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-void-zero-message',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'void-zero-name-data',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);return c.signal.reason.name;}',
    invocation: 'frames()',
    refused: false,
    native: 'AbortError',
    nativeMode: 'exact',
  },
  {
    id: 'void-zero-stack',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);return c.signal.reason.stack;}',
    invocation: 'frames()',
    refused: true,
    native: 'AbortError',
    nativeMode: 'contains',
  },
  {
    id: 'whole-undefined-alias',
    source:
      'function frames(){const missing=undefined;const c=new AbortController();c.abort(missing);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'whole-void-alias',
    source:
      'function frames(){const missing=void 0;const c=new AbortController();c.abort(missing);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'whole-void-alias-chain',
    source:
      'function frames(){const missing=void 0;const reason=missing;const c=new AbortController();c.abort(reason);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'asserted-void-zero',
    source:
      'function frames(){const c=new AbortController();c.abort(((void 0) as unknown));return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'void-boolean',
    source:
      'function frames(){const c=new AbortController();c.abort(void true);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'void-parameter-read',
    source:
      'function frames(value:unknown){const c=new AbortController();c.abort(void value);return c.signal.reason.message;}',
    invocation: 'frames({})',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'void-literal-array',
    source:
      'function frames(value:unknown){const c=new AbortController();c.abort(void [value]);return c.signal.reason.message;}',
    invocation: 'frames({})',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'void-native-Error',
    source:
      'function frames(){const c=new AbortController();c.abort(void new Error("ignored"));return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'controller-alias',
    source:
      'function frames(){const c=new AbortController();const alias=c;alias.abort(void 0);return alias.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'signal-alias',
    source:
      'function frames(){const c=new AbortController();const signal=c.signal;c.abort(void 0);return signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'ordinary-nested-block',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);{return c.signal.reason.message;}}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'literal-spread-undefined',
    source:
      'function frames(){const c=new AbortController();c.abort(...[void 0]);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'native-call',
    source:
      'function frames(){const c=new AbortController();AbortController.prototype.abort.call(c,void 0);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'native-apply',
    source:
      'function frames(){const c=new AbortController();AbortController.prototype.abort.apply(c,[void 0]);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'native-Reflect-apply',
    source:
      'function frames(){const c=new AbortController();Reflect.apply(AbortController.prototype.abort,c,[void 0]);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'constructor-alias',
    source:
      'function frames(){const Controller=AbortController;const c=new Controller();c.abort(void 0);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'literal-true-arm',
    source:
      'function frames(){const c=new AbortController();if(true){c.abort(void 0);}return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'unknown-arm-with-data',
    source:
      'function frames(flag:boolean){const c=new AbortController();if(flag){c.abort(void 0);}else{c.abort({message:"fixed"});}return c.signal.reason.message;}',
    invocation: 'frames(true)',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'first-literal-data',
    source:
      'function frames(){const c=new AbortController();c.abort({message:"fixed"});c.abort(void 0);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'supplied-error-first',
    source:
      'function frames(error:Error){const c=new AbortController();c.abort(error);c.abort(void 0);return c.signal.reason.message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    native: 'supplied',
    nativeMode: 'exact',
  },
  {
    id: 'local-Error-first',
    source:
      'function frames(){const c=new AbortController();c.abort(new Error("fixed"));c.abort(void 0);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'own-abort-method',
    source:
      'function frames(){const c=new AbortController();c.abort=()=>{};c.abort(void 0);return c.signal.reason?.message??"fixed";}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'borrowed-native-over-own',
    source:
      'function frames(){const c=new AbortController();c.abort=()=>{};AbortController.prototype.abort.call(c,void 0);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'local-AbortController',
    source:
      'class AbortController{signal={reason:{message:"fixed"}};abort(_reason?:unknown){}}function frames(){const c=new AbortController();c.abort(void 0);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'local-undefined-value',
    source:
      'function frames(undefined:string){const c=new AbortController();c.abort(undefined);return String(c.signal.reason);}',
    invocation: 'frames("kept")',
    refused: false,
    native: 'kept',
    nativeMode: 'exact',
  },
  {
    id: 'void-callback-first-data',
    source:
      'function frames(){const c=new AbortController();c.abort(void prepare());return c.signal.reason.message;function prepare(){c.abort({message:"fixed"});}}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'void-member-getter-first-data',
    source:
      'function frames(){const input={get value(){c.abort({message:"fixed"});return 0;}};const c=new AbortController();c.abort(void input.value);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'void-coercion-first-data',
    source:
      'function frames(){const input={valueOf(){c.abort({message:"fixed"});return 0;}};const c=new AbortController();c.abort(void ((input as unknown as number)+1));return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'ignored-direct-tail-first-data',
    source:
      'function frames(){const c=new AbortController();(c.abort as(...args:unknown[])=>void)(void 0,prepare());return c.signal.reason.message;function prepare(){c.abort({message:"fixed"});}}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'ignored-Reflect-tail-first-data',
    source:
      'function frames(){const c=new AbortController();(Reflect.apply as(...args:unknown[])=>unknown)(AbortController.prototype.abort,c,[void 0],prepare());return c.signal.reason.message;function prepare(){c.abort({message:"fixed"});}}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'later-message-write',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);Object.defineProperty(c.signal.reason,"message",{value:"fixed"});return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'later-signal-replacement',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);Object.defineProperty(c,"signal",{value:{reason:{message:"fixed"}}});return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'later-captured-call',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);prepare();return c.signal.reason.message;function prepare(){Object.defineProperty(c.signal.reason,"message",{value:"fixed"});}}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'conditional-later-write',
    source:
      'function frames(flag:boolean){const c=new AbortController();if(flag){c.abort(void 0);}else{c.abort(void true);}Object.defineProperty(c.signal.reason,"message",{value:"fixed"});return c.signal.reason.message;}',
    invocation: 'frames(true)',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'mutable-reason-alias',
    source:
      'function frames(){let reason:unknown=void 0;reason={message:"fixed"};const c=new AbortController();c.abort(reason);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'void-shadowed-undefined',
    source:
      'function frames(undefined:string){const c=new AbortController();c.abort(void undefined);return c.signal.reason.message;}',
    invocation: 'frames("kept")',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'null-remains-data',
    source:
      'function frames(){const c=new AbortController();c.abort(null);return c.signal.reason??"fixed";}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'void-local-constructor',
    source:
      'function frames(){const c=new AbortController();class Error{constructor(_message?:unknown){c.abort({message:"fixed"});}}c.abort(void new Error("ignored"));return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'omitted-reason-pin',
    source:
      'function frames(){const c=new AbortController();c.abort();return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'global-undefined-pin',
    source:
      'function frames(){const c=new AbortController();c.abort(undefined);return c.signal.reason.message;}',
    invocation: 'frames()',
    refused: true,
    native: 'This operation was aborted',
    nativeMode: 'exact',
  },
  {
    id: 'saved-reason-words-replaced',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);const reason=c.signal.reason;Object.defineProperty(reason,"message",{value:"fixed"});return reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'stored-reason-words-replaced',
    source:
      'function frames(){const c=new AbortController();c.abort(void 0);const box={reason:c.signal.reason};Object.defineProperty(box.reason,"message",{value:"fixed"});return box.reason.message;}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
  {
    id: 'computed-reason-key-replaces-words',
    source:
      'function frames(){const key={toString(){Object.defineProperty(c.signal.reason,"message",{value:"fixed"});return "message";}};const c=new AbortController();c.abort(void 0);return c.signal.reason[key as never];}',
    invocation: 'frames()',
    refused: false,
    native: 'fixed',
    nativeMode: 'exact',
  },
];

describe('abort undefined reason readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'abort-undefined-reasons.ts', source);
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

describe('shared abort undefined reason admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, retainedShape }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining(
      retainedShape === true ? 'whose flags differ' : 'a shared module that answers otherwise',
    );
    const expected = refused || retainedShape === true ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
