import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTypeScript } from '../src/compiler/index.ts';
import {
  application,
  type Application,
  compiledApp,
  positionOf,
  removed,
} from './fixtures/application.ts';

/**
 * A middleware inside one with a guard binds its context's defaults where the host runs its part
 * before `next`, ahead of that guard: one that may throw or have an effect is refused there, as a
 * statement is; one of literals, functions, names bound before it and imports is not.
 */

const PARENT = 'app/boards/[projectId]/middleware.ts';
const CHILD = 'app/boards/[projectId]/[toString]/middleware.ts';

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

const REASON = "of the context's pattern, is bound before `next` for each request";

const REST_REASON = 'context is destructured by name at every depth';

interface ExpectedRefusal {
  readonly fileName: string;
  readonly at: readonly number[] | undefined;
  readonly reason: boolean;
}

/** Rest syntax keeps its existing refusal; other cases assert the guarded-default location. */
function expectedRefusals(
  text: string,
  marker: string | undefined,
  rest: boolean,
): readonly ExpectedRefusal[] {
  if (rest) return [{ fileName: CHILD, at: undefined, reason: true }];
  const at = marker === undefined ? undefined : positionOf(text, marker);
  return at === undefined ? [] : [{ fileName: CHILD, at: [at.line, at.column], reason: true }];
}

const CASES = [
  {
    what: 'reported-whole-plus',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +(all as any) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '+(all as any)',
    rest: false,
  },
  {
    what: 'whole-minus',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = -(all as any) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '-(all as any)',
    rest: false,
  },
  {
    what: 'whole-product',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = (all as any) * 2 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '(all as any) * 2',
    rest: false,
  },
  {
    what: 'whole-relational',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = (all as any) < 0 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '(all as any) < 0',
    rest: false,
  },
  {
    what: 'whole-loose-equality',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = (all as any) == 0 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '(all as any) == 0',
    rest: false,
  },
  {
    what: 'whole-template',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async ({ params: all, params: { missing = \`value:\${all as any}\` } }, next) => {
const response = await next();
response.headers.set('X-Read', String(missing));
return response;
}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;
`,
    marker: `\`value:\${all as any}\``,
    rest: false,
  },
  {
    what: 'whole-conditional-product',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = (true ? all as any : 0) * 2 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '(true ? all as any : 0) * 2',
    rest: false,
  },
  {
    what: 'whole-through-default-name',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { seed = all, missing = +(seed as any) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '+(seed as any)',
    rest: false,
  },
  {
    what: 'whole-computed-key',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { [all as unknown as string]: missing } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: 'all as unknown as string',
    rest: false,
  },
  {
    what: 'params-rest-plus',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: { ...all }, params: { missing = +(all as any) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '+(all as any)',
    rest: true,
  },
  {
    what: 'params-rest-computed-key',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: { ...all }, params: { [all as unknown as string]: missing } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: 'all as unknown as string',
    rest: true,
  },
  {
    what: 'primitive-param-plus',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: { projectId, missing = +projectId } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'primitive-param-product',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: { projectId, missing = +projectId * 2 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'primitive-param-template',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: `import type { RouteMiddleware } from '@arkorlab/reactive-state/server';
export default (async ({ params: { projectId, missing = \`\${projectId}-fixed\` } }, next) => {
const response = await next();
response.headers.set('X-Read', String(missing));
return response;
}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;
`,
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-read-without-conversion',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = all } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-kept-as-data',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(all));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'literal-default',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: { missing = 1 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-typeof',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = typeof all } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-not',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = !all } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-strict-equality',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = all === all } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-plus-without-outer-guard',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async (_context,next)=>{const response=await next();response.headers.set('X-Fixed','yes');return response;}) satisfies RouteMiddleware;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +(all as any) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-plus-in-inner-guard',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({ params: all, params: { missing = +(all as any) } }, next) => {\nawait requirePublishedProject(String(missing));\nconst response = await next();\nresponse.headers.set('X-Read', 'fixed');\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'literal-computed-key',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: { [\"7\"]: missing } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'global-undefined-plus',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: { missing = +(undefined as unknown as number) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'nested-typeof-plus',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +(typeof all) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'nested-not-plus',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +((!all) as unknown as number) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'stored-typeof-operand',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = typeof all, header = +missing } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(header));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'stored-equality-operand',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = all === all, header = +missing } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(header));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-conditional-test',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = all ? 1 : 2 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-logical-test',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = all && 1 } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-and-string-operand',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +((all as any) && '2') } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-and-number-operand',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +((all as any) && 2) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-and-nested-logical-operand',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +(((all as any) && '2') || '3') } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: undefined,
    rest: false,
  },
  {
    what: 'whole-or-still-converts',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +((all as any) || '2') } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: "+((all as any) || '2')",
    rest: false,
  },
  {
    what: 'whole-nullish-still-converts',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +((all as any) ?? '2') } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: "+((all as any) ?? '2')",
    rest: false,
  },
  {
    what: 'whole-and-object-still-converts',
    parent:
      "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nimport { requirePublishedProject } from '@/publication';\nexport default (async ({params},next)=>{await requirePublishedProject(params.projectId);return next();}) satisfies RouteMiddleware<{projectId:string}>;\n",
    text: "import type { RouteMiddleware } from '@arkorlab/reactive-state/server';\nexport default (async ({ params: all, params: { missing = +((all as any) && all) } }, next) => {\nconst response = await next();\nresponse.headers.set('X-Read', String(missing));\nreturn response;\n}) satisfies RouteMiddleware<{ projectId: string; toString: string; [key: string]: any }>;\n",
    marker: '+((all as any) && all)',
    rest: false,
  },
] as const;

describe('a middleware’s context defaults under a guard around it', () => {
  let api: API;
  const apps: Application[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const each of apps) {
      await removed(each);
    }
  });

  it.each(CASES)('$what', async ({ parent, text, marker, rest }) => {
    const app = await application({
      [PARENT]: parent,
      [CHILD]: text,
      'app/boards/[projectId]/[toString]/page.tsx':
        'export default function Page(){return <p>fixed</p>;}',
      'defaults.ts': file(
        "export const DEFAULT_TENANT = 'main';",
        "export const MARKER = Symbol('marker');",
        "export const HOLDER = { get id(): string { throw new Error('read'); } };",
        "export const KEY = 'tenant';",
        "export function fallbackTenant(): string { return 'main'; }",
      ),
    });
    apps.push(app);
    const compiled = compiledApp(app, api);
    const found = compiled.refusals.map((refusal) => {
      return {
        fileName: refusal.fileName,
        at: rest ? undefined : [refusal.line, refusal.column],
        reason: refusal.reason.includes(rest ? REST_REASON : REASON),
      };
    });
    const expected = expectedRefusals(text, marker, rest);

    expect(found).toStrictEqual(expected);
  });
});
