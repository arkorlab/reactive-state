import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

const source =
  "import type {RouteMiddleware} from '@arkorlab/reactive-state/server';\nimport {requirePublishedProject} from '@/publication';\nexport default (async({params},next)=>{\nconst decision=[{allowed:false}];\nawait requirePublishedProject(params.projectId);\ndecision.values().next({}).value!.allowed=true;\nconst response=await next();\nresponse.headers.set('X-Decision',String(decision[0]!.allowed));\nreturn response;\n}) satisfies RouteMiddleware<{projectId:string}>;\n";

describe('native array iterator ignored object input', () => {
  const { apps, compile } = compilerApplications();

  it('native-next-ignored-object', async () => {
    const app = await application({ 'app/boards/[projectId]/middleware.ts': source });
    apps.push(app);

    expect(compile(app).refusals.map((x) => x.reason)).toStrictEqual([
      expect.stringContaining('mutated'),
    ]);
  });
});
