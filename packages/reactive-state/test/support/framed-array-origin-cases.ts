export interface ArrayResultCase {
  readonly group: string;
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly reader: boolean;
  readonly refused: boolean;
}
export const arrayResultCases: readonly ArrayResultCase[] = [
  {
    group: 'apply',
    id: 'apply-for-later-index',
    source:
      'function frames(error:Error){const args:[number]=[0];const values=[{stack:"fixed"},error];let text="";for(let step=0;step<2;step++){text+=Array.prototype.at.apply(values,args)!.stack;args[0]=1;}return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'apply',
    id: 'apply-while-later-index',
    source:
      'function frames(error:Error){const args:[number]=[0];const values=[{stack:"fixed"},error];let step=0,text="";while(step++<2){text+=Array.prototype.at.apply(values,args)!.stack;args[0]=1;}return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'apply',
    id: 'apply-const-alias-later-index',
    source:
      'function frames(error:Error){const original:[number]=[0];const args=original;const values=[{stack:"fixed"},error];let text="";for(const step of [0,1]){text+=Array.prototype.at.apply(values,args)!.stack;original[0]=1;}return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'apply',
    id: 'apply-fresh-loop-arguments',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"},error];let text="";for(let step=0;step<2;step++){const args:[number]=[0];text+=Array.prototype.at.apply(values,args)!.stack;args[0]=1;}return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'apply',
    id: 'apply-singleton-loop',
    source:
      'function frames(error:Error){const args:[number]=[0];const values=[{stack:"fixed"},error];let text="";for(const step of [0]){text+=Array.prototype.at.apply(values,args)!.stack;args[0]=1;}return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'apply',
    id: 'apply-later-nonrepeated-write',
    source:
      'function frames(error:Error){const args:[number]=[0];const values=[{stack:"fixed"},error];const text=Array.prototype.at.apply(values,args)!.stack;args[0]=1;return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'apply',
    id: 'apply-loop-unselected-write',
    source:
      'function frames(error:Error){const args:[number]=[0];const values=[{stack:"fixed"},error];let text="";for(let step=0;step<2;step++){text+=Array.prototype.at.apply(values,args)!.stack;if(false)args[0]=1;}return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'apply',
    id: 'apply-loop-no-write',
    source:
      'function frames(error:Error){const args:[number]=[0];const values=[{stack:"fixed"},error];let text="";for(let step=0;step<2;step++)text+=Array.prototype.at.apply(values,args)!.stack;return text;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'entries',
    id: 'entries-value-slot',
    source: 'function frames(error:Error){return Object.entries({failure:error})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'entries',
    id: 'entries-numeric-order',
    source:
      'function frames(error:Error){return Object.entries({later:{stack:"fixed"},2:error})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'entries',
    id: 'entries-selected-later',
    source:
      'function frames(error:Error){return Object.entries({first:{stack:"fixed"},failure:error})[1]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'entries',
    id: 'entries-getter-value',
    source:
      'function frames(error:Error){return Object.entries({get failure(){return error;}})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'entries',
    id: 'entries-native-alias',
    source:
      'function frames(error:Error){const entries=Object.entries;return entries({failure:error})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'entries',
    id: 'entries-const-result-alias',
    source:
      'function frames(error:Error){const entries=Object.entries({failure:error});return entries[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'entries',
    id: 'entries-key-slot-data',
    source: 'function frames(error:Error){return Object.entries({failure:error})[0]![0];}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'entries',
    id: 'entries-excluded-value',
    source:
      'function frames(error:Error){return Object.entries({first:{stack:"fixed"},failure:error})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'entries',
    id: 'entries-overwrite-data',
    source:
      'function frames(error:Error){return Object.entries({...{failure:error},failure:{stack:"fixed"}})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'entries',
    id: 'entries-local-made-words',
    source:
      'function frames(error:Error){return Object.entries({failure:new Error("fixed")})[0]![1].message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'entries',
    id: 'entries-local-shadow',
    source:
      'function frames(error:Error){const Object={entries(_input:unknown){return[["fixed",{stack:"fixed"}]]as const;}};return Object.entries({failure:error})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'entries',
    id: 'entries-symbol-omitted',
    source:
      'function frames(error:Error){return Object.entries({[Symbol.iterator]:error,failure:{stack:"fixed"}})[0]![1].stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flat-scalar-error',
    source: 'function frames(error:Error){return [error].flat()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flat-nested-error',
    source: 'function frames(error:Error){return [[error]].flat()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flat-depth-two',
    source: 'function frames(error:Error){return [[[error]]].flat(2)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flat-const-array-alias',
    source: 'function frames(error:Error){const values=[[error]];return values.flat()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flat-borrowed-native',
    source:
      'function frames(error:Error){const values=[error];values.flat=()=>[{stack:"fixed"}]as never;return(Array.prototype.flat.call(values)[0]as{stack:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flatmap-identity-array',
    source: 'function frames(error:Error){return [error].flatMap(value=>[value])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flatmap-scalar-result',
    source: 'function frames(error:Error){return [0].flatMap(()=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flatmap-borrowed-native',
    source:
      'function frames(error:Error){const values=[error];values.flatMap=()=>[{stack:"fixed"}]as never;return(Array.prototype.flatMap.call(values,(value)=>[value])[0]as{stack:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flat-selected-data',
    source: 'function frames(error:Error){return [{stack:"fixed"},error].flat()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flat-nested-data',
    source: 'function frames(error:Error){return [[{stack:"fixed"}]].flat()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flat-zero-retains-array',
    source:
      'function frames(error:Error){return ([[error]].flat(0)[0]as unknown as{stack:string}).stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flat-own-method-data',
    source:
      'function frames(error:Error){const values=[error];values.flat=()=>[{stack:"fixed"}]as never;return values.flat()[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flatmap-own-method-data',
    source:
      'function frames(error:Error){const values=[error];values.flatMap=()=>[{stack:"fixed"}]as never;return values.flatMap(value=>[value])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flat-local-made-words',
    source: 'function frames(error:Error){return [[new Error("fixed")]].flat()[0]!.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flatmap-empty-result',
    source: 'function frames(error:Error){return [error].flatMap(()=>[]as Error[])[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flatmap-data-result',
    source:
      'function frames(error:Error){return [error].flatMap(()=>[{stack:"fixed"}])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flatmap-hole-input-retains-error',
    source: 'function frames(error:Error){return[,error].flatMap(value=>[value])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    group: 'flat',
    id: 'flatmap-hole-input-selected-data',
    source:
      'function frames(error:Error){return[,{stack:"fixed"},error].flatMap(value=>[value])[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flatmap-empty-holes-skip-callback',
    source:
      'function frames(error:Error){return new Array<Error>(2).flatMap(()=>error)[0]?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    group: 'flat',
    id: 'flatmap-empty-alias-skip-callback',
    source:
      'function frames(error:Error){const values:Error[]=[];return values.flatMap(()=>error).at(-1)?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];
