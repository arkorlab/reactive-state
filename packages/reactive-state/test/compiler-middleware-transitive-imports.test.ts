import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Static runtime dependencies cannot carry singleton state across extracted middleware parts. */
const CASES = [
  {
    id: 'reported-two-reexport-barrels',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'export-star-barrels',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export*from"./shared";',
      'reader.ts': 'export*from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'namespace-export-reader',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export*as state from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{state}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(state.decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'import-then-local-export',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'import{allow}from"./shared";export{allow};',
      'reader.ts': 'import{decision}from"./shared";export{decision};',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'deeper-reexport-paths',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./left";',
      'reader.ts': 'export{decision}from"./right";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'left.ts': 'export{allow}from"./shared";',
      'right.ts': 'export{decision}from"./shared";',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'cyclic-barrels-terminate',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";export{decision}from"./reader";',
      'reader.ts': 'export{decision}from"./shared";export{allow}from"./writer";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'canonical-path-and-alias',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"@/shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'default-reader-export',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{default}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import decision from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'transitive-common-direct-root',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/shared";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'side-effect-import-evaluation',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'import"./shared";export function allow(){return "fixed";}',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'empty-import-evaluation',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'import{}from"./shared";export function allow(){return "fixed";}',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'inline-type-import-still-evaluates',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts':
        'import{type Decision}from"./shared";export function allow():Decision{return{allowed:true};}',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'inline-type-export-still-evaluates',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{type Decision}from"./shared";export function allow(){return "fixed";}',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'before-envelope-shares-transitive-state',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{const shown=String(decision.allowed)+request.method;allow();const response=await next();response.headers.set("X-Decision",shown);return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
  {
    id: 'different-state-modules-data',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./other";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'other.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: false,
  },
  {
    id: 'explicit-type-import-is-erased',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts':
        'import type{Decision}from"./shared";export function allow():Decision{return{allowed:true};}',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: false,
  },
  {
    id: 'explicit-type-export-is-erased',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export type{Decision}from"./shared";export function allow(){return "fixed";}',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: false,
  },
  {
    id: 'unreachable-other-file-is-irrelevant',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./other";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'unused.ts': 'export{decision}from"./shared";',
      'other.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: false,
  },
  {
    id: 'guard-alone-is-accepted',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision","fixed");return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: false,
  },
  {
    id: 'envelope-alone-is-accepted',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{verify}from"@/verify";import{decision}from"@/reader";export default(async({params,request},next)=>{verify(params.projectId);const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: false,
  },
  {
    id: 'no-guard-single-host-graph',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow}from"@/writer";import{decision}from"@/reader";export default(async({params,request},next)=>{const allowed=allow(request.url);const response=await next();response.headers.set("X-Decision",String(decision.allowed)+allowed);return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: false,
  },
  {
    id: 'direct-identity-existing-refusal',
    files: {
      'shared.ts':
        'export interface Decision{allowed:boolean}export const decision={allowed:false};export function allow(_value?:string){decision.allowed=true;return "fixed";}export default decision;',
      'writer.ts': 'export{allow}from"./shared";',
      'reader.ts': 'export{decision}from"./shared";',
      'verify.ts':
        'export function verify(value:string){if(value==="denied")throw new Error("denied");}',
      'app/boards/[projectId]/middleware.ts':
        'import type{RouteMiddleware}from"@arkorlab/reactive-state/server";import{allow,decision}from"@/shared";export default(async({params,request},next)=>{allow();const response=await next();response.headers.set("X-Decision",String(decision.allowed));return response;})satisfies RouteMiddleware<{projectId:string}>;',
    },
    refused: true,
  },
] as const;

describe('transitive runtime imports across split middleware', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ files, refused }) => {
    const app = await application(files);
    apps.push(app);
    const compiled = compile(app);

    expect(compiled.refusals).toHaveLength(refused ? 1 : 0);
    expect(compiled.refusals[0]?.reason ?? '').toContain(
      refused ? 'both the guard and the envelope' : '',
    );
  });
});
