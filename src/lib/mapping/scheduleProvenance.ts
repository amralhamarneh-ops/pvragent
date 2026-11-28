/** Keep processed/impacted exports on the comparison side, even if uploaded under the wrong subrole. */
export function isReferenceProgramme(name:string,subrole?:string|null) {
  if(subrole==='reference')return true;
  const normalized=name.replace(/[_–—]/g,' ');
  if(/\b(?:impacted|post[ -]?impact|after[ -]?impact|with[ -]?impact|processed)\b/i.test(normalized))return true;
  return /\bimpact\b/i.test(normalized.replace(/\b(?:pre|before|without|un)[ -]?impact\b/gi,''));
}
