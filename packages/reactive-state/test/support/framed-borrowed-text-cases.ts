/** Expanded text arguments and borrowed native Error words. */
export const BORROWED_TEXT_CASES = [
  {
    name: 'concat literal spread',
    source: "function frames(error: Error & string) { return ''.concat(...[error]); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'concat nested spread',
    source: "function frames(error: Error & string) { return ''.concat(...[...[error]]); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'concat lexical spread',
    source:
      "function frames(error: Error & string) { const values=[error]; return ''.concat(...values); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'concat typed Error array',
    source: "function frames(values: Error[] & string[]) { return ''.concat(...values); }",
    framed: true,
    invocation: "frames([new Error('ours')])",
  },
  {
    name: 'concat ordinary spread text',
    source: "function frames() { return ''.concat(...['first', 'second']); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'concat written Error words',
    source: "function frames() { return ''.concat(...[new Error('ours')]); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'array concat keeps error values',
    source: 'function frames(error: Error) { return [].concat(...[error]).length; }',
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'custom concat retains error values',
    source:
      'function frames(error: Error) { const text={concat(...values: unknown[]) { return values.length; }}; return text.concat(...[error]); }',
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed Error toString call',
    source: 'function frames(error: Error) { return Error.prototype.toString.call(error); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed Error toString apply',
    source: 'function frames(error: Error) { return Error.prototype.toString.apply(error, []); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'reflected Error toString',
    source:
      'function frames(error: Error) { return Reflect.apply(Error.prototype.toString, error, []); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed Error toString opaque args',
    source:
      'function frames(error: Error, args: unknown[]) { return Error.prototype.toString.apply(error, args); }',
    framed: true,
    invocation: "frames(new Error('ours'), [])",
  },
  {
    name: 'borrowed Error native alias',
    source:
      'function frames(error: Error) { const text=Error.prototype.toString; return text.call(error); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed Error uses native not own method',
    source:
      "function frames(error: Error) { error.toString=()=> 'fixed'; return Error.prototype.toString.call(error); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed Error written words',
    source: "function frames() { return Error.prototype.toString.call(new Error('ours')); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed Error plain own data',
    source:
      "function frames() { return Error.prototype.toString.call({name:'Error',message:'ours'}); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'shadowed Error native identity',
    source:
      "function frames(error: Error) { const Error={prototype:{toString() { return 'fixed'; }}}; return Error.prototype.toString.call(error); }",
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'shadowed Reflect Error conversion',
    source:
      "function frames(error: Error) { const Reflect={apply(...args: unknown[]) { return 'fixed'; }}; return Reflect.apply(Error.prototype.toString, error, []); }",
    framed: false,
    invocation: "frames(new Error('ours'), [])",
  },
  {
    name: 'custom method named toString',
    source:
      "function frames(error: Error) { const custom={toString() { return 'fixed'; }}; return custom.toString.call(error); }",
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
];
