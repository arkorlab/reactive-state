import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Source construction metadata includes executed defaults and fields of nested constructions. */
describe('construction defaults and nested instance fields', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "class Fresh { constructor(flag = (() => { try { items[0]='changed'; return true; } catch { return false; } })()) { if(flag) Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    "class Fresh { constructor(flag = (() => { try { items[0]='changed'; return true; } catch { return false; } })()) { if(flag) Object.freeze(this); } } const missing=undefined; return String(Object.isFrozen(new Fresh(missing)));",
    "function change(flag=(items[0]='changed', 0)) { return flag; } class Fresh { constructor() { try { change(); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));",
    "function change(flag=(items[0]='changed', 0)) { return flag; } class Fresh { constructor() { try { change.call(null); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));",
    "function* change(flag=(items[0]='changed', 0)) { yield flag; } class Fresh { constructor() { try { change(); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));",
    "class Inner { flag=(()=>{try { items[0]='changed'; return true; } catch { return false; }})(); constructor() {} } class Fresh { constructor() { const inner=new Inner(); if(inner.flag) Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    "class Inner { flag=(()=>{try { items[0]='changed'; return true; } catch { return false; }})(); constructor() {} } const Alias=Inner; class Fresh { constructor() { const inner=new Alias(); if(inner.flag) Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
  ])('refuses an input write executed while constructing: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    "class Fresh { constructor(flag=(items[0]='changed', true)) { if(flag) Object.freeze(this); } } return String(Object.isFrozen(new Fresh(true)));",
    "function change(flag=(items[0]='changed', 0)) { return flag; } class Fresh { constructor() { change(0); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    "function* change(flag=(items[0]='changed', 0)) { yield flag; } class Fresh { constructor() { change(0); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    'class Inner { flag=items.length; constructor() {} } class Fresh { constructor() { new Inner(); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
    "class Fresh { constructor() { const later=(flag=(items[0]='changed', 0))=>flag; Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    'class Fresh { constructor(flag=items.length) { if(flag) Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
    "class Inner { flag=()=>{ items[0]='changed'; }; constructor() {} } class Fresh { constructor() { new Inner(); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
  ])('keeps unselected defaults, pure fields and deferred work: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** Input mutations can change construction control flow when the authority freezes its copy. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/construction-execution.ts': `export function label(items: string[]): string { ${body} }`,
    'components/construction-execution.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/construction-execution';",
      'export default function ConstructionExecution({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
