/** Borrowed native array conversions and mutable methods read by a later execution owner. */
export const BORROWED_ARRAY_CASES = [
  {
    name: 'borrowed join call',
    source: "function frames(error: Error) { return Array.prototype.join.call([error], ','); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed join apply',
    source: "function frames(error: Error) { return Array.prototype.join.apply([error], [',']); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'reflected join',
    source:
      "function frames(error: Error) { return Reflect.apply(Array.prototype.join, [error], [',']); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed toString call',
    source: 'function frames(error: Error) { return Array.prototype.toString.call([error]); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed toString apply',
    source: 'function frames(error: Error) { return Array.prototype.toString.apply([error], []); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'reflected toString',
    source:
      'function frames(error: Error) { return Reflect.apply(Array.prototype.toString, [error], []); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'opaque join apply arguments',
    source:
      'function frames(error: Error, args: unknown[]) { return Array.prototype.join.apply([error], args); }',
    framed: true,
    invocation: "frames(new Error('ours'), [])",
  },
  {
    name: 'opaque reflected join arguments',
    source:
      'function frames(error: Error, args: unknown[]) { return Reflect.apply(Array.prototype.join, [error], args); }',
    framed: true,
    invocation: "frames(new Error('ours'), [])",
  },
  {
    name: 'borrowed join ignores own join',
    source:
      "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; return Array.prototype.join.call(values); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed toString ignores own toString',
    source:
      "function frames(error: Error) { const values = [error]; values.toString = () => 'fixed'; return Array.prototype.toString.call(values); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed join ignores aliased root overrides',
    source:
      "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; values.toString = () => 'fixed'; const alias = values; return Array.prototype.join.call(alias); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'constant native join alias',
    source:
      'function frames(error: Error) { const join = Array.prototype.join; return join.call([error]); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'constant native toString alias',
    source:
      'function frames(error: Error) { const text = Array.prototype.toString; return text.apply([error], []); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'typed error array receiver',
    source: 'function frames(errors: Error[]) { return Array.prototype.join.call(errors); }',
    framed: true,
    invocation: "frames([new Error('ours')])",
  },
  {
    name: 'nested borrowed error array',
    source: 'function frames(error: Error) { return Array.prototype.join.call([[error]]); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'ordinary join ignores aliased own toString',
    source:
      "function frames(error: Error) { const values = [error]; values.toString = () => 'fixed'; const alias = values; return alias.join(','); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed toString refuses own join',
    source:
      "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; return Array.prototype.toString.call(values); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'aliased borrowed toString refuses own join',
    source:
      "function frames(error: Error) { const values = [error]; values.join = () => 'fixed'; const alias = values; return Array.prototype.toString.call(alias); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed toString own noncallable number join',
    source:
      'function frames(error: Error) { const values = [error]; values.join = 0; return Array.prototype.toString.call(values); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed join own noncallable number join',
    source:
      'function frames(error: Error) { const values = [error]; values.join = 0; return Array.prototype.join.call(values); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed toString own noncallable undefined join',
    source:
      'function frames(error: Error) { const values = [error]; values.join = undefined; return Array.prototype.toString.call(values); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed join own noncallable undefined join',
    source:
      'function frames(error: Error) { const values = [error]; values.join = undefined; return Array.prototype.join.call(values); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed join preserves written error words',
    source: "function frames() { return Array.prototype.join.call([new Error('ours')]); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed toString preserves written words',
    source: "function frames() { return Array.prototype.toString.call([new Error('ours')]); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed join plain data',
    source: "function frames() { return Array.prototype.join.call([{message: 'data'}]); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed join ordinary text',
    source: "function frames() { return Array.prototype.join.call(['first', 'second']); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'lexically shadowed Array',
    source:
      "function frames(error: Error) { const Array = {prototype: {join() { return 'fixed'; }}}; return Array.prototype.join.call([error]); }",
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'lexically shadowed Reflect',
    source:
      "function frames(error: Error) { const Reflect = {apply(...args: unknown[]) { return args.length ? 'fixed' : 'empty'; }}; return Reflect.apply(Array.prototype.join, [error], []); }",
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'nested array refuses own text method',
    source:
      "function frames(error: Error) { const values = [error]; values.toString = () => 'fixed'; return Array.prototype.join.call([values]); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'module object changed after reader declaration',
    source:
      "const methods = {join() { return 'fixed'; }}; function frames(error: Error) { const values = [error]; values.join = methods.join; return values.join(','); } methods.join = Array.prototype.join;",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'module function changed after reader declaration',
    source:
      "function own() { return 'fixed'; } function frames(error: Error) { const values = [error]; values.join = own; return values.join(','); } own = Array.prototype.join;",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'outer object changed before deferred reader',
    source:
      "function frames(error: Error) { const methods = {join() { return 'fixed'; }}; const read = () => { const values = [error]; values.join = methods.join; return values.join(','); }; methods.join = Array.prototype.join; return read(); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'module object changed before class method runs',
    source:
      "const methods = {join() { return 'fixed'; }}; class Reader { read(error: Error) { const values = [error]; values.join = methods.join; return values.join(','); } } methods.join = Array.prototype.join; function frames(error: Error) { return new Reader().read(error); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'unchanged module object custom method refused',
    source:
      "const methods = {join() { return 'fixed'; }}; function frames(error: Error) { const values = [error]; values.join = methods.join; return values.join(','); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'module method captured before replacement refused',
    source:
      "const methods = {join() { return 'fixed'; }}; const captured = methods.join; function frames(error: Error) { const values = [error]; values.join = captured; return values.join(','); } methods.join = Array.prototype.join;",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'module function captured before replacement refused',
    source:
      "function own() { return 'fixed'; } const captured = own; function frames(error: Error) { const values = [error]; values.join = captured; return values.join(','); } own = Array.prototype.join;",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'immediate local capture before replacement refused',
    source:
      "function frames(error: Error) { const methods = {join() { return 'fixed'; }}; const values = [error]; values.join = methods.join; methods.join = Array.prototype.join; return values.join(','); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'unchanged deferred local object refused',
    source:
      "function frames(error: Error) { const methods = {join() { return 'fixed'; }}; const read = () => { const values = [error]; values.join = methods.join; return values.join(','); }; return read(); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'other lexical object replacement refused',
    source:
      "const methods = {join() { return 'fixed'; }}; function frames(error: Error) { const values = [error]; values.join = methods.join; return values.join(','); } function unrelated() { const methods = {join() { return 'data'; }}; methods.join = Array.prototype.join; return methods; }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'delete custom join reveals native',
    source:
      "function frames(error: Error) { const values=[error]; values.join=()=> 'fixed'; delete (values as {join?:()=>string}).join; return values.join(); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'delete custom toString reveals native',
    source:
      "function frames(error: Error) { const values=[error]; values.toString=()=> 'fixed'; delete (values as {toString?:()=>string}).toString; return values.toString(); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'delete join affects borrowed toString',
    source:
      "function frames(error: Error) { const values=[error]; values.join=()=> 'fixed'; delete (values as {join?:()=>string}).join; return Array.prototype.toString.call(values); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'dynamic delete clears join proof',
    source:
      "function frames(error: Error, key: string) { const values=[error]; values.join=()=> 'fixed'; delete values[key]; return values.join(); }",
    framed: true,
    invocation: "frames(new Error('ours'), 'join')",
  },
  {
    name: 'delete via array alias',
    source:
      "function frames(error: Error) { const values=[error]; values.join=()=> 'fixed'; const alias=values; delete alias.join; return values.join(); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'delete unrelated property refuses custom join',
    source:
      "function frames(error: Error) { const values=[error]; values.join=()=> 'fixed'; delete values.extra; return values.join(); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'restored custom join after deletion refused',
    source:
      "function frames(error: Error) { const values=[error]; values.join=()=> 'fixed'; delete values.join; values.join=()=> 'again'; return values.join(); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'method captured before argument delete refused',
    source:
      "function frames(error: Error) { const values=[error]; values.join=()=> 'fixed'; return values.join(delete values.join); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
];
