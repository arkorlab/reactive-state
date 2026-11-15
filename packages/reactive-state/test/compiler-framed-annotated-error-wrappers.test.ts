import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Non-intercepting wrappers (`new Proxy(target, {})`, `Proxy.revocable(target, {}).proxy`,
 * nullish/`Reflect.get` read-forwarding handlers, `Object` identity/clone wrappers, and reflected
 * or borrowed `Object` wrappers) preserve the universal written-word proof on `: Error` bindings
 * while rejecting custom `get` traps, mutable handler bindings, spreads, unproven target branches,
 * and `.stack` reads.
 */

const CASES = [
  {
    framed: false,
    id: 'empty-proxy-handler-annotated-error',
    source: `function text() { const error: Error = new Proxy(new Error('fixed'), {}); return String(error); }`,
  },
  {
    framed: false,
    id: 'nullish-get-trap-proxy-annotated-error',
    source: `function text() { const error: Error = new Proxy(new TypeError('fixed'), { get: undefined } as ProxyHandler<Error>); return error.message; }`,
  },
  {
    framed: false,
    id: 'reflect-get-trap-proxy-annotated-error',
    source: `function text() { const error: Error = new Proxy(new Error('fixed'), { get: Reflect.get }); return String(error); }`,
  },
  {
    framed: false,
    id: 'unrelated-set-trap-proxy-annotated-error',
    source: `function text() { const error: Error = new Proxy(new RangeError('fixed'), { set() { return false; } }); return error.message; }`,
  },
  {
    framed: false,
    id: 'revocable-proxy-immediate-selection-annotated-error',
    source: `function text() { const error: Error = Proxy.revocable(new Error('fixed'), {}).proxy; return String(error); }`,
  },
  {
    framed: false,
    id: 'nested-freeze-and-proxy-conditional-local-branches',
    source: `function text(flag: boolean) { const error: Error = new Proxy(flag ? Object.freeze(new Error('one')) : new TypeError('two'), {}); return String(error); }`,
  },
  {
    framed: false,
    id: 'reflected-object-construct-wrapper-annotated-error',
    source: `function text() { const error: Error = Reflect.construct(Object, [new Error('fixed')]) as Error; return error.message; }`,
  },
  {
    framed: false,
    id: 'borrowed-object-call-wrapper-annotated-error',
    source: `function text() { const error: Error = Object.call(null, new Error('fixed')) as Error; return String(error); }`,
  },
  {
    framed: true,
    id: 'proxy-over-mixed-conditional-target-refused',
    source: `declare function passThrough(error: Error): Error; function text(flag: boolean, external: Error) { const error: Error = new Proxy(flag ? new Error('fixed') : passThrough(external), {}); return String(error); }`,
  },
  {
    framed: true,
    id: 'proxy-with-custom-get-trap-refused',
    source: `function text(flag: boolean, external: Error) { const error: Error = new Proxy(new Error('fixed'), { get(target, key) { return flag ? Reflect.get(target, key) : external.message; } }); return String(error); }`,
  },
  {
    framed: true,
    id: 'proxy-with-mutable-handler-identifier-refused',
    source: `function text(external: Error) { const handler: ProxyHandler<Error> = {}; handler.get = () => external.message; const error: Error = new Proxy(new Error('fixed'), handler); return error.message; }`,
  },
  {
    framed: true,
    id: 'proxy-with-spread-handler-refused',
    source: `declare const extra: ProxyHandler<Error>; function text() { const error: Error = new Proxy(new Error('fixed'), { ...extra }); return String(error); }`,
  },
  {
    framed: true,
    id: 'empty-proxy-stack-read-still-refused',
    source: `function frames() { const error: Error = new Proxy(new Error('fixed'), {}); return error.stack; }`,
  },
  {
    framed: false,
    id: 'object-freeze-local-error-pin',
    source: `function text() { const error: Error = Object.freeze(new Error('fixed')); return String(error); }`,
  },
] as const;

describe('non-intercepting wrappers on annotated Error bindings', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'annotated-error-wrappers.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
