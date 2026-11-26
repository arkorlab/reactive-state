import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'abort-supplied-error',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort(error);return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'abort-caught-error',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){const controller=new AbortController();controller.abort(error);return controller.signal.reason.stack;}}',
    invocation: 'frames()',
    reader: true,
    refused: true,
  },
  {
    id: 'first-error-keeps-error',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort(error);controller.abort({stack:"fixed"});return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'controller-alias-error',
    source:
      'function frames(error:Error){const controller=new AbortController();const alias=controller;alias.abort(error);return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'signal-alias-error',
    source:
      'function frames(error:Error){const controller=new AbortController();const signal=controller.signal;controller.abort(error);return signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-borrowed-abort-error',
    source:
      'function frames(error:Error){const controller=new AbortController();AbortController.prototype.abort.call(controller,error);return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-borrowed-ignores-own-abort',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort=()=>{};AbortController.prototype.abort.call(controller,error);return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'native-default-abort-error',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort();return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'first-data-keeps-data',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort({stack:"fixed"});controller.abort(error);return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'ordinary-reason-data',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort({stack:"fixed"});return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'local-made-words-data',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort(new Error("fixed"));return controller.signal.reason.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'controller-local-shadow',
    source:
      'function frames(error:Error){class AbortController{signal={reason:{stack:"fixed"}};abort(_reason:unknown){}}const controller=new AbortController();controller.abort(error);return controller.signal.reason.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'own-abort-does-not-abort',
    source:
      'function frames(error:Error){const controller=new AbortController();controller.abort=()=>{};controller.abort(error);return controller.signal.reason?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'other-controller-unaborted-data',
    source:
      'function frames(error:Error){const controller=new AbortController();const other=new AbortController();other.abort(error);return controller.signal.reason?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('native abort reasons readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('native abort reasons admissions', () => {
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
