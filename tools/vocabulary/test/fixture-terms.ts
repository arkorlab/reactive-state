import type { Term } from '../src/terms.ts';

/**
 * Terms of the tests' own, so that what the tests say of the scan holds whatever `TERMS` lists:
 * a word, two words read as one term, and a word found inside others.
 */
export const FIXTURE_TERMS: readonly Term[] = [
  {
    id: 'widget',
    pattern: /\bwidgets?(?![\da-z])/giu,
    why: 'a word the fixture refuses',
    finds: ['widget', 'widgets', 'theWidget', 'MY_WIDGET_KEY'],
    passes: ['widgetry'],
  },
  {
    id: 'sprocket-gear',
    pattern: /\bsprocket(?:-|_? +)gears?(?![\da-z])/giu,
    why: 'two words the fixture refuses together',
    finds: [
      'sprocket gear',
      'sprocket-gear',
      'sprocketGear',
      'sprocket_gear',
      'the sprocket\n * gear',
    ],
    passes: ['sprockets gear', 'sprocket\n\ngear', 'sprocket gearbox'],
  },
  {
    id: 'gizmo',
    pattern: /gizmo/giu,
    why: 'a word the fixture refuses inside others too',
    finds: ['gizmo', 'regizmoed'],
    passes: ['gizm'],
  },
];

/** Forms of the tests' own that are blanked before a file is searched. */
export const FIXTURE_ALLOWED: readonly RegExp[] = [
  /(?<![\p{L}\p{N}_-])x-widget-ok(?![\p{L}\p{N}_-])/giu,
  /\bCopyright \d{4} Widget Makers\b/gu,
];
