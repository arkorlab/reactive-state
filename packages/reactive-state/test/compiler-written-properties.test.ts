import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded write still executes before the trailing JSON string is selected. */
const fixture = stateFixture('written-properties', 'WrittenProperties', 'ok');

/** Strict writes and the source setter they invoke must not fault an authority initializer. */
describe('written property assignment exceptions', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(Object.freeze({value:0}) as never).value = 1',
    '++(Object.freeze({value:0}) as never).value',
    '(Object.freeze({value:0}) as never).value++',
    '(Object.freeze({value:0}) as never).value += 1',
    '(Object.freeze([0]) as never)[0] = 1',
    '(Object.freeze([0]) as never).length++',
    '(Object.freeze({}) as never).value = 1',
    '(Object.preventExtensions({}) as never).value = 1',
    '(Object.seal({}) as never).value = 1',
    "Object.defineProperty({}, 'value', {value:0}).value = 1",
    'Object.defineProperties({}, {value:{value:0}}).value++',
    'Object.create(null, {value:{value:0}}).value = 1',
    '({get value() {return 0;}} as never).value = first',
    '(Object.freeze({get value() {return 0;}}) as never).value++',
    '(Object.freeze({value:0}) as never).value ||= 1',
    '(Object.freeze({value:1}) as never).value &&= 1',
    '(Object.freeze({value:null}) as never).value ??= 1',
    "({set value(_value: string) {throw new Error('bad');}} as never).value = first",
    "({set ['value'](_value: string) {throw new Error('bad');}} as never)['value'] = first",
    "({get value() {return 0;},set value(_value: number) {throw new Error('bad');}} as never).value = 1",
    "({set value(_value: number) {throw new Error('bad');},get value() {return 0;}} as never).value = 1",
    "({set value(_value: number) {throw new Error('bad');}} as never).value += 1",
    "({set value(_value: number) {throw new Error('bad');}} as never).value ||= 1",
    "({get value() {return 1;},set value(_value: number) {throw new Error('bad');}} as never).value &&= 1",
    "++({set value(_value: number) {throw new Error('bad');}} as never).value",
    "Object.freeze({set value(_value: string) {throw new Error('bad');}}).value = first",
    "Object.defineProperty({}, 'value', {set: function() {throw new Error('bad');}}).value = first",
    "({set value(_value: string) {decodeURIComponent('%');}} as never).value = first",
  ])('refuses a necessarily throwing write: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    '({value:0}).value = 1',
    'Object.seal({value:0}).value += 1',
    'Object.preventExtensions({value:0}).value++',
    "Object.defineProperty({}, 'value', {value:0,writable:true}).value = 1",
    '(Object.freeze({value:0}) as never).value &&= 1',
    '(Object.freeze({value:0}) as never).value ??= 1',
    '(Object.freeze({value:1}) as never).value ||= 1',
    '({set value(_value: string) {}} as never).value = first',
    'Object.freeze({set value(_value: string) {}}).value = first',
    "({get value() {return 0;},set value(_value: number) {throw new Error('skipped');}} as never).value &&= 1",
    "({get value() {return void Object.defineProperty(this, 'value', {value:0,writable:true});}} as never).value++",
    "({set value(_value: string) {throw new Error('old');},value:0} as never).value = 1",
    "({set value(_value: string) {throw new Error('old');},set value(_value: string) {}} as never).value = first",
    "({set value(_value: string) {try {throw new Error('caught');} catch {}}} as never).value = first",
    "({set value(_value: string) {const later=() => {throw new Error('later');};}} as never).value = first",
    "(() => {try {({set value(_value: string) {throw new Error('caught');}} as never).value = first;} catch {} return first;})()",
    '(() => {try {(Object.freeze({value:0}) as never).value = 1;} catch {} return first;})()',
    '(Object.freeze({__proto__:{set value(_value: string) {}}}) as never).value = first',
    '(Object.freeze({}) as never).__proto__ = Object.prototype',
    'Object.freeze({value:{nested:0}}).value.nested = 1',
  ])('keeps writable, skipped, caught and nonthrowing setter work: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
