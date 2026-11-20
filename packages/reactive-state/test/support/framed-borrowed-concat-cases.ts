/** Native string concat borrowing converts its receiver and forwarded arguments. */
export const BORROWED_CONCAT_CASES = [
  {
    name: 'borrowed concat call',
    source: "function frames(error: Error) { return String.prototype.concat.call('', error); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed concat apply',
    source: "function frames(error: Error) { return String.prototype.concat.apply('', [error]); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'reflected concat',
    source:
      "function frames(error: Error) { return Reflect.apply(String.prototype.concat, '', [error]); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed concat call spread',
    source:
      "function frames(error: Error) { return String.prototype.concat.call('', ...[error]); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed concat lexical apply list',
    source:
      "function frames(error: Error) { const args=[error]; return String.prototype.concat.apply('', args); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed concat typed apply list',
    source: "function frames(args: Error[]) { return String.prototype.concat.apply('', args); }",
    framed: true,
    invocation: "frames([new Error('ours')])",
  },
  {
    name: 'borrowed concat constant native alias',
    source:
      "function frames(error: Error) { const concat=String.prototype.concat; return concat.call('', error); }",
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed concat caught engine words',
    source:
      "function frames() { try { JSON.parse('bad'); } catch(error) { return String.prototype.concat.call('', error); } }",
    framed: true,
    invocation: 'frames()',
  },
  {
    name: 'borrowed concat converts error receiver',
    source: 'function frames(error: Error) { return String.prototype.concat.call(error); }',
    framed: true,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed concat opaque list keeps receiver',
    source:
      'function frames(error: Error, args: unknown[]) { return String.prototype.concat.apply(error, args); }',
    framed: true,
    invocation: "frames(new Error('ours'), [])",
  },
  {
    name: 'borrowed concat written error words',
    source: "function frames() { return String.prototype.concat.call('', new Error('ours')); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed concat apply written words',
    source: "function frames() { return String.prototype.concat.apply('', [new Error('ours')]); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'reflected concat written words',
    source:
      "function frames() { return Reflect.apply(String.prototype.concat, '', [new Error('ours')]); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed concat data text',
    source: "function frames() { return String.prototype.concat.call('first', 'second'); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed concat plain message object',
    source: "function frames() { return String.prototype.concat.call('', {message:'ours'}); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'custom borrowed concat',
    source:
      "function frames(error: Error) { const custom={concat() { return 'fixed'; }}; return custom.concat.call('', error); }",
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'shadowed String concat',
    source:
      "function frames(error: Error) { const String={prototype:{concat(){return 'fixed';}}}; return String.prototype.concat.call('', error); }",
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'shadowed Reflect concat',
    source:
      "function frames(error: Error) { const Reflect={apply(...args: unknown[]) { return 'fixed'; }}; return Reflect.apply(String.prototype.concat, '', [error]); }",
    framed: false,
    invocation: "frames(new Error('ours'), [])",
  },
  {
    name: 'borrowed array concat retains values',
    source:
      'function frames(error: Error) { return Array.prototype.concat.call([], error).length; }',
    framed: false,
    invocation: "frames(new Error('ours'))",
  },
  {
    name: 'borrowed concat written receiver words',
    source: "function frames() { return String.prototype.concat.call(new Error('ours')); }",
    framed: false,
    invocation: 'frames()',
  },
  {
    name: 'borrowed concat empty text',
    source: "function frames() { return String.prototype.concat.call('fixed'); }",
    framed: false,
    invocation: 'frames()',
  },
];
