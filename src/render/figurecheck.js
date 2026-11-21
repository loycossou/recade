import { collectFigures } from './figures.js';
import { plainText } from './inline.js';

/** @typedef {{file:string,line:number,column:number,rule:string,severity:'warn',message:string}} Finding */

/** The least number of figures each document asks for, and what they show. The templates say the same. */
export const MIN_FIGURES = {
  D1: { count: 3, what: 'actors and system context, main journeys, states of the main object' },
  D2: { count: 3, what: 'containers, deployment, one key sequence' },
  D3: { count: 1, what: 'trust boundaries and data flows' },
  PLAN: { count: 1, what: 'phases timeline' },
};

/**
 * Warnings about the figures of a parsed document: one for each figure with no caption (it would read "Figure 3: " and
 * nothing else), and one when a D1, D2, D3 or PLAN has fewer figures than its template asks for.
 * @param {{meta:any, blocks:any[], file:string}} doc
 * @returns {Finding[]}
 */
export function figureFindings(doc) {
  const out = [];
  const warn = (line, rule, message) => out.push({ file: doc.file, line, column: 1, rule, severity: 'warn', message });
  const figures = collectFigures(doc.blocks);
  for (const f of figures) {
    if (plainText(f.caption ?? []).trim() === '') {
      warn(f.line, 'figure-caption', `Figure ${f.number} has no caption. Put <!-- caption: ... --> right before a Mermaid block, or the text in the alt of an image.`);
    }
  }
  const min = MIN_FIGURES[doc.meta?.doc_id];
  if (min && figures.length < min.count) {
    warn(1, 'figures-min', `${doc.meta.doc_id} has ${figures.length} of the ${min.count} figures it asks for at least: ${min.what}.`);
  }
  return out;
}
