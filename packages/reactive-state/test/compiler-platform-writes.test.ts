import { describe, expect, it } from 'vitest';

import { application, type Application, refusalOf } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Platform stability proofs follow lexical local writes before a construction uses its input. */
describe('shared platform inputs after local writes', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "const options: BlobPropertyBag = {endings:'transparent'}; options.endings='native'; return text + new Blob([text], options).size;",
    "const options: FilePropertyBag = {lastModified:0,endings:'transparent'}; options.endings='native'; return text + new File([text], 'x', options).size;",
    "const options: BlobPropertyBag = {endings:'transparent'}; const alias=options; alias.endings='native'; return text + new Blob([text], options).size;",
    "let options: BlobPropertyBag = {endings:'transparent'}; options={endings:'native'}; return text + new Blob([text], options).size;",
    "let target='https://example.com/'; target='/relative'; return text + new Request(target).url;",
    "let target='https://example.com/'; target='/relative'; return text + Response.redirect(target).status;",
    "let endings: EndingType='transparent'; endings='native'; return text + new Blob([text], {endings}).size;",
    "let key='type'; key='endings'; return text + new Blob([text], {[key]:'native'}).size;",
    "const options: BlobPropertyBag = {endings:'transparent'}; Object.assign(options, {endings:'native'}); return text + new Blob([text], options).size;",
    "const options: BlobPropertyBag = {endings:'transparent'}; function change(value: BlobPropertyBag) { value.endings='native'; } change(options); return text + new Blob([text], options).size;",
    "const options: BlobPropertyBag = {endings:'transparent'}; const change=()=>{ options.endings='native'; }; [0].forEach(change); return text + new Blob([text], options).size;",
    "const options: BlobPropertyBag = {endings:'transparent'}; unknownChange(options); return text + new Blob([text], options).size;",
    "const options: BlobPropertyBag = {endings:'transparent'}; Object.defineProperty(options, 'endings', {value:'native'}); return text + new Blob([text], options).size;",
    "const options={endings:'transparent' as EndingType,set type(value: string) { this.endings='native'; }}; options.type='text/plain'; return text + new Blob([text], options).size;",
    "const options={endings:'transparent' as EndingType,other:{n:0}}; (options as any).other=options; (options as any).other.endings='native'; return text + new Blob([text], options).size;",
  ])('refuses a platform value whose earlier initializer was changed: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('a shared module that answers otherwise');
  });

  it.each([
    "const options={endings:'transparent'} as const; return text + new Blob([text], options).size;",
    "const target='https://example.com/'; const alias=target; return text + new Request(alias).url;",
    "const options={endings:'transparent'} as const; function unrelated(options: BlobPropertyBag) { options.endings='native'; } return text + new Blob([text], options).size;",
    "const options={endings:'transparent'} as const; { const options: BlobPropertyBag={}; options.endings='native'; } return text + new Blob([text], options).size;",
    "const options={endings:'transparent'} as const; [{endings:'transparent'}].forEach((options: BlobPropertyBag)=>{ options.endings='native'; }); return text + new Blob([text], options).size;",
    "const options: BlobPropertyBag={endings:'transparent'}; const blob=new Blob([text], options); options.endings='native'; return text + blob.size;",
    "const options={endings:'transparent'} as const; function read(value: BlobPropertyBag) { return value.endings; } read(options); return text + new Blob([text], options).size;",
    "const target='https://example.com/'; function unrelated(target: string) { target='/relative'; return target; } return text + Response.redirect(target).status;",
  ])('keeps unchanged inputs and unrelated lexical writes: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });

  it.each([
    "const options: BlobPropertyBag={endings:'transparent'}; options.type='text/plain'; return text + new Blob([text], options).size;",
    "const options={endings:'transparent' as const,other:{n:0}}; options.other.n++; return text + new Blob([text], options).size;",
    "let target='https://example.com/'; target='https://example.org/'; return text + new Request(target).url;",
    "const options: BlobPropertyBag={endings:'transparent'}; options.endings='transparent'; return text + new Blob([text], options).size;",
  ])('keeps writes whose platform input remains proven stable: %s', async (body) => {
    const app = await fixture(body);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});

/** A shared function is checked independently of the callback supplied by any particular caller. */
async function fixture(body: string): Promise<Application> {
  return application({
    'domain/platform-writes.ts': `export function label(text: string, unknownChange: (value: BlobPropertyBag) => void = () => {}) { ${body} }`,
    'components/platform-writes.reactive.tsx': [
      "import { useReactiveState } from 'framework/react';",
      "import TodoCommands from '@/components/todo-commands.reactive';",
      "import { label } from '@/domain/platform-writes';",
      'export default function PlatformWrites({projectId, first}: {projectId: string; first: string}) {',
      '  const [selected, setSelected] = useReactiveState(first);',
      '  return <section><button onClick={() => setSelected(first)}>reset</button><TodoCommands projectId={projectId} id={label(selected)} /></section>;',
      '}',
    ].join('\n'),
  });
}
