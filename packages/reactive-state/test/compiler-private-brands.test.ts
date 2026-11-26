import { describe, expect, it } from 'vitest';

import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** The operation result is discarded after synchronous work, before the JSON state is returned. */
const fixture = stateFixture('private-brands', 'PrivateBrands');

/** Private reads and writes require the declaring class's brand; private membership needs an object. */
describe('written private brand failures', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    '(()=>{class Box{#value="x";read(other:Box):string{return other.#value;}}return new Box().read({} as Box);})()',
    '(()=>{class Box{#value="x";write(other:Box):string{other.#value="next";return "ok";}}return new Box().write({} as Box);})()',
    '(()=>{class Box{#value=0;write(other:Box):number{return other.#value++;}}return new Box().write({} as Box);})()',
    '(()=>{class Box{#value="x";has(other:unknown):boolean{return #value in (other as Box);}}return new Box().has(1);})()',
    '(()=>{class Box{#value="x";has(other:unknown):boolean{return #value in (other as Box);}}return new Box().has(null);})()',
    '(()=>{class Box{static #value="x";static read(other:typeof Box):string{return other.#value;}}return Box.read({} as typeof Box);})()',
    '(()=>{class Box{static #value="x";static read(other:typeof Box):string{return other.#value;}}class Other{}return Box.read(Other as typeof Box);})()',
    'new(class{#value="x";constructor(){({} as this).#value;}})()',
  ])('refuses a private operation proven to fail: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals.map((each) => each.reason)).toStrictEqual([
      expect.stringContaining('no JSON holds'),
    ]);
  });

  it.each([
    '(()=>{class Box{#value="x";read():string{return this.#value;}}return new Box().read();})()',
    '(()=>{class Box{#value="x";read(other:Box):string{return other.#value;}}return new Box().read(new Box());})()',
    '(()=>{class Box{#value="x";read(other:Box):string{return other.#value;}}class Child extends Box{}return new Box().read(new Child());})()',
    '(()=>{class Box{static #value="x";static read(other:typeof Box):string{return other.#value;}}return Box.read(Box);})()',
    '(()=>{class Box{#value="x";has(other:unknown):boolean{return #value in (other as Box);}}return new Box().has({});})()',
    '(()=>{class Box{#value="x";read(other:Box):string{return other.#value;}}return new Box().read(first as unknown as Box);})()',
    '(()=>{class Box{#value="x";read(other:Box):string{return other.#value;}}try{return new Box().read({} as Box);}catch{return "caught";}})()',
    '(()=>{class Box{#value="x";read(other:Box):string{return other.#value;}}return false && new Box().read({} as Box);})()',
    '(()=>{class Box{#value="x";read(){return ()=>({} as Box).#value;}}return new Box().read();})()',
    '(class Box{#value="x";read(other:Box):string{return other.#value;}})',
    '(()=>{class Box{#value="x";read(other:Box):string{other=new Box();return other.#value;}}return new Box().read({} as Box);})()',
    '(()=>{class Box{#value="x";read(other:Box):string{return other.#value;}}Box.prototype.read=()=>"safe";return new Box().read({} as Box);})()',
  ])('keeps valid brands and uncertain or unexecuted operations: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
