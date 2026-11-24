import { describe, expect, it } from 'vitest';

import { application, type Application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Binding defaults execute only where the selected argument projection may be undefined. */
describe('construction binding pattern defaults', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    'class Fresh { constructor({flag=change()}={}) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh())); } catch { return "threw"; }',
    'class Fresh { constructor({flag=change()}={}) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh({}))); } catch { return "threw"; }',
    'class Fresh { constructor([flag=change()]=[]) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh())); } catch { return "threw"; }',
    'class Fresh { constructor({box:{flag=change()}={}}={}) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh())); } catch { return "threw"; }',
    'function helper({flag=change()}={}) { return flag; } class Fresh { constructor() { try { helper(); Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));',
    'const options={}; const alias=options; class Fresh { constructor({flag=change()}={}) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh(alias))); } catch { return "threw"; }',
    `function tag(_strings:TemplateStringsArray,{flag=change()}={}) { return flag; } class Fresh { constructor() { try { tag\`\${{}}\`; Object.freeze(this); } catch {} } } return String(Object.isFrozen(new Fresh()));`,
    'class Fresh { constructor({early=change(),bad:{x}}={early:undefined,bad:null as never}) {} } try { return String(Object.isFrozen(new Fresh())); } catch { return items[0] ?? "empty"; }',
    'class Fresh { constructor({bad:{x},later=change()}={bad:items.length>0?{x:0}:null as never,later:undefined}) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh())); } catch { return "threw"; }',
  ])('refuses input effects in a selected binding default: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals.map((refusal) => refusal.reason)).toStrictEqual([
      expect.stringContaining('flags differ between the browser'),
    ]);
  });

  it.each([
    'class Fresh { constructor({flag=change()}={}) { Object.freeze(this); } } return String(Object.isFrozen(new Fresh({flag:0})));',
    'class Fresh { constructor([flag=change()]=[]) { Object.freeze(this); } } return String(Object.isFrozen(new Fresh([0])));',
    'class Fresh { constructor({box:{flag=change()}={}}={}) { Object.freeze(this); } } return String(Object.isFrozen(new Fresh({box:{flag:0}})));',
    'function helper({flag=change()}={}) { return flag; } class Fresh { constructor() { helper({flag:0}); Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor({flag=items.length}={}) { Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
    "class Fresh { constructor({flag=()=>{items[0]='changed';}}={}) { Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));",
    'function tag([head=change()]:readonly string[]) { return head; } class Fresh { constructor() { tag`present`; Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
    'class Fresh { constructor({box:{flag=change()}}={} as never) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh())); } catch { return "threw"; }',
    'class Fresh { constructor({box:{flag=change()}}:{box:{flag?:number}}) { Object.freeze(this); } } try { return String(Object.isFrozen(new Fresh({box:null} as never))); } catch { return "threw"; }',
    'class Fresh { constructor([...[flag=change()]]:number[]) { Object.freeze(this); } } return String(Object.isFrozen(new Fresh([0])));',
    'class Fresh { constructor({toString=change()}={}) { Object.freeze(this); } } return String(Object.isFrozen(new Fresh()));',
  ])('keeps present projections, pure defaults and deferred functions: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    'class Fresh { constructor({bad:{x},later=change()}={bad:null as unknown as {x:number},later:undefined}) {} } try { return String(Object.isFrozen(new Fresh())); } catch { return "caught"; }',
    'class Fresh { constructor({x}: {x:number},later=change()) {} } try { return String(Object.isFrozen(new Fresh(null as never))); } catch { return "caught"; }',
    'class Fresh { constructor({bad:{x},later=change()}={later:undefined} as never) {} } try { return String(Object.isFrozen(new Fresh())); } catch { return "caught"; }',
    'class Fresh { constructor([[x],later=change()]=[null as never,undefined]) {} } try { return String(Object.isFrozen(new Fresh())); } catch { return "caught"; }',
  ])('stops later defaults after a definite earlier destructuring failure: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A default can throw only for the authority-frozen input before the new receiver is frozen. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/construction-pattern-defaults.ts': `export function label(items:string[]):string { function change() { items[0]='changed'; return 0; } ${body} }`,
    'components/construction-pattern-defaults.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/construction-pattern-defaults';",
      'export default function ConstructionPatternDefaults({projectId, first}: {projectId: string; first: string[]}) {',
      '  const [items, setItems] = useReactiveState(first);',
      '  return <section><button onClick={() => setItems([])}>clear</button><TodoCommands projectId={projectId} id={label(items)} /></section>;',
      '}',
    ].join('\n'),
  });
}
