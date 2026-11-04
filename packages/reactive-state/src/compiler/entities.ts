/**
 * The character references JSX decodes in its text and in an attribute's string, as Babel's parser
 * and SWC's decode them before React's transform reads the text: XHTML's named references, and a
 * code point written in decimal (`&#160;`) or in hexadecimal after a lowercase `x` (`&#xA0;`). A
 * reference that names nothing is left as it is written.
 */

/**
 * XHTML's 253 named references, as `name code` pairs: the table Babel, SWC and TypeScript decode by
 * alike. A name written without a code point is the one after the name before it: the run of
 * Latin-1 from `nbsp` (160) to `yuml` (255).
 */
const NAMED = [
  'quot 34 amp 38 apos 39 lt 60 gt 62',
  'nbsp 160 iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg',
  'plusmn',
  'sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave',
  'Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml',
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN',
  'szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute',
  'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml',
  'yacute thorn yuml',
  'OElig 338 oelig 339 Scaron 352 scaron 353 Yuml 376 fnof 402 circ 710 tilde 732',
  'Alpha 913 Beta 914 Gamma 915 Delta 916 Epsilon 917 Zeta 918 Eta 919 Theta 920 Iota 921',
  'Kappa 922 Lambda 923 Mu 924 Nu 925 Xi 926 Omicron 927 Pi 928 Rho 929 Sigma 931 Tau 932',
  'Upsilon 933 Phi 934 Chi 935 Psi 936 Omega 937 alpha 945 beta 946 gamma 947 delta 948',
  'epsilon 949 zeta 950 eta 951 theta 952 iota 953 kappa 954 lambda 955 mu 956 nu 957 xi 958',
  'omicron 959 pi 960 rho 961 sigmaf 962 sigma 963 tau 964 upsilon 965 phi 966 chi 967 psi 968',
  'omega 969 thetasym 977 upsih 978 piv 982 ensp 8194 emsp 8195 thinsp 8201 zwnj 8204 zwj 8205',
  'lrm 8206 rlm 8207 ndash 8211 mdash 8212 lsquo 8216 rsquo 8217 sbquo 8218 ldquo 8220',
  'rdquo 8221 bdquo 8222 dagger 8224 Dagger 8225 bull 8226 hellip 8230 permil 8240 prime 8242',
  'Prime 8243 lsaquo 8249 rsaquo 8250 oline 8254 frasl 8260 euro 8364 image 8465 weierp 8472',
  'real 8476 trade 8482 alefsym 8501 larr 8592 uarr 8593 rarr 8594 darr 8595 harr 8596',
  'crarr 8629 lArr 8656 uArr 8657 rArr 8658 dArr 8659 hArr 8660 forall 8704 part 8706',
  'exist 8707 empty 8709 nabla 8711 isin 8712 notin 8713 ni 8715 prod 8719 sum 8721 minus 8722',
  'lowast 8727 radic 8730 prop 8733 infin 8734 ang 8736 and 8743 or 8744 cap 8745 cup 8746',
  'int 8747 there4 8756 sim 8764 cong 8773 asymp 8776 ne 8800 equiv 8801 le 8804 ge 8805',
  'sub 8834 sup 8835 nsub 8836 sube 8838 supe 8839 oplus 8853 otimes 8855 perp 8869 sdot 8901',
  'lceil 8968 rceil 8969 lfloor 8970 rfloor 8971 lang 9001 rang 9002 loz 9674 spades 9824',
  'clubs 9827 hearts 9829 diams 9830',
].join(' ');

/** The code point of a name written alone: the one after the name before it. */
const CODE = /^\d+$/u;

/** The named references, by name. */
const ENTITIES: ReadonlyMap<string, string> = (() => {
  const table = new Map<string, string>();
  const words = NAMED.split(' ');
  let code = 0;
  for (const [index, word] of words.entries()) {
    if (CODE.test(word)) {
      continue;
    }
    const next = words[index + 1] ?? '';
    code = CODE.test(next) ? Number(next) : code + 1;
    table.set(word, String.fromCodePoint(code));
  }
  return table;
})();

/** The largest code point there is. */
const MAX_CODE_POINT = 0x10_ff_ff;

/** A reference: a hexadecimal or a decimal code point, or a name of at most ten characters. */
const REFERENCE = /&(?:#x([\dA-Fa-f]+)|#(\d+)|(\w{1,10}));/gu;

const HEXADECIMAL = 16;
const DECIMAL = 10;

/** `text` with each character reference it holds decoded, as JSX decodes it. */
export function decodeEntities(text: string): string {
  return text.replaceAll(
    REFERENCE,
    (
      written,
      hexadecimal: string | undefined,
      decimal: string | undefined,
      name: string | undefined,
    ) => {
      if (name !== undefined) {
        return ENTITIES.get(name) ?? written;
      }
      const code =
        hexadecimal === undefined
          ? Number.parseInt(decimal ?? '', DECIMAL)
          : Number.parseInt(hexadecimal, HEXADECIMAL);
      return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : written;
    },
  );
}

/**
 * A run of JSX text as React's transform makes it a child, from the text the parser decoded: each
 * line's tabs as spaces, its spaces trimmed where it meets another line, the lines of white space
 * alone dropped, and the rest joined by one space — `undefined` where nothing is left. Babel's
 * `cleanJSXElementLiteralChild`, which SWC follows, so that what the authority renders of the JSX
 * is what Next.js would have rendered of it.
 */
export function jsxTextChild(raw: string): string | undefined {
  const lines = decodeEntities(raw).split(/\r\n|\n|\r/u);
  let lastNonEmpty = 0;
  for (const [index, line] of lines.entries()) {
    if (/[^\t ]/u.test(line)) {
      lastNonEmpty = index;
    }
  }
  let text = '';
  for (const [index, line] of lines.entries()) {
    let trimmed = line.replaceAll('\t', ' ');
    if (index !== 0) {
      trimmed = trimmed.replace(/^ +/u, '');
    }
    if (index !== lines.length - 1) {
      trimmed = withoutTrailingSpaces(trimmed);
    }
    if (trimmed !== '') {
      text += index === lastNonEmpty ? trimmed : `${trimmed} `;
    }
  }
  return text === '' ? undefined : text;
}

/** `line` without the spaces it ends with: spaces alone, as React's transform trims them. */
function withoutTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    end -= 1;
  }
  return line.slice(0, end);
}

/**
 * An attribute's string as React's transform makes it a prop: decoded, and each line break with the
 * white space after it folded into one space (Babel's `convertAttribute`).
 */
export function jsxAttributeString(raw: string): string {
  return decodeEntities(raw).replaceAll(/\n\s+/gu, ' ');
}
