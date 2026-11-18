import { renderHtml } from './html.js';
import { withBrowser } from './browser.js';

async function print(browser, doc, options) {
  const page = await browser.newPage();
  try {
    await page.setContent(renderHtml(doc, options), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Page size, margins, header and footer come from the @page rules of the HTML (see pageCss in html.js).
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await page.close();
  }
}

/**
 * Renders a document to a PDF through Chromium: the HTML of renderHtml, A4 (or the theme's page size), margins from
 * the theme, running header and footer (none on the cover), page numbers. The browser comes from `options.browser`
 * when given, else is launched for this call.
 * @param {import('./parse.js').Doc} doc
 * @param {{theme:any, labels:Record<string,string>, figures?:Map<string,any>, browser?:import('playwright').Browser}} options
 * @returns {Promise<Buffer>}
 */
export async function renderPdf(doc, options) {
  if (options.browser) return print(options.browser, doc, options);
  return withBrowser((browser) => print(browser, doc, options));
}
