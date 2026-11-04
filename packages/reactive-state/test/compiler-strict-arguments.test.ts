import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A prop-dependent initializer discards each operation after it is synchronously evaluated. */
const fixture = stateFixture('strict-arguments', 'StrictArguments');

/** A module's strict arguments object throws when its own callee accessor is read. */
describe('strict arguments poison reads', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(function(){return arguments.callee;})()',
    '(function(){return arguments["callee"];})()',
    '(function(){return arguments?.callee;})()',
    '(function(){const key="callee";return arguments[key];})()',
    '(function(){const args=arguments;return args.callee;})()',
    '({get held(){return arguments.callee;}}).held',
    'new class{constructor(){void arguments.callee;}}',
    '(function(value=arguments.callee){return value;})()',
    '(function(){return (()=>arguments.callee)();})()',
  ])('refuses a necessarily evaluated strict arguments accessor: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(function(){return ({callee:first}).callee;})()',
    '(function(){return arguments.length;})()',
    '(function(){return arguments[0];})(first)',
    '(function(){return arguments.caller;})()',
    '(function(){return Object.getOwnPropertyDescriptor(arguments,"callee");})()',
    '(function(){try{return arguments.callee;}catch{return first;}})()',
    'false&&(function(){return arguments.callee;})()',
    'function(){return arguments.callee;}',
    '(function*(){return arguments.callee;})()',
    '(async function(){return arguments.callee;})().catch(()=>first)',
    '(function(value=arguments.callee){return value;})(first)',
    '(function(){return new Proxy(arguments,{get(){return first;}}).callee;})()',
    '(function(){return (null as any)?.[arguments.callee];})()',
    '(function(){const record={arguments:{callee:first}};return record.arguments.callee;})()',
  ])('keeps ordinary data, uninvoked, skipped and handled accesses: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
