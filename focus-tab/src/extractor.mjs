import { extractPage } from './extract.mjs';
globalThis.__focusTabExtract = (max) => extractPage(document, max);
