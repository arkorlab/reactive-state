/** Source-written tuple receiver replacements and the exact ordinary-data controls. */
export const REFLECT_TARGET_CASES = [
  {
    id: 'data-target-replaced-by-error-and-stack',
    kind: 'candidate',
    source:
      'function frames(error: Error) { const args = [{stack: "fixed"}, "name"] as const; (args as unknown as [Error, string])[0] = error; (args as unknown as [Error, string])[1] = "stack"; return Reflect.get(...args); }',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'original-data-key-change',
    kind: 'safe-control',
    source:
      'const error={stack:"fixed",name:"data"}; const args=[error,"name"] as const; function frames(){return Reflect.get(...args);} (args as unknown as [typeof error,string])[1]="stack";',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'untouched-error-safe-key',
    kind: 'safe-control',
    source:
      'const error=new Error("ours"); const args=[error,"name"] as const; function frames(){return Reflect.get(...args);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'data-target-replaced-by-data-and-stack',
    kind: 'safe-control',
    source:
      'function frames() { const args = [{stack: "first"}, "name"] as const; (args as unknown as [{stack: string}, string])[0] = {stack: "replacement"}; (args as unknown as [{stack: string}, string])[1] = "stack"; return Reflect.get(...args); }',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'shadowed-reflect-fixed-data',
    kind: 'safe-control',
    source:
      'function frames(error: Error) { const Reflect = {get(_value: unknown, _key: string) { return "fixed"; }}; const args = [error, "stack"] as const; return Reflect.get(...args); }',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'original-error-key-mutation',
    kind: 'positive-pin',
    source:
      'const error=new Error("ours"); const args=[error,"name"] as const; function frames(){return Reflect.get(...args);} (args as unknown as [Error,string])[1]="stack";',
    invocation: 'frames()',
    refused: true,
  },
] as const;
