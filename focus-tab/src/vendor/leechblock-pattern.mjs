/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Extracted from proginosko/LeechBlockNG-chrome common.js at
// e88ef65427ade4f7b14703325500c0ede975ca1b (2026-10-11).
// Original author: James Anderson. Only ESM export/formatting changed.
export function patternToRegExp(pattern, matchSubdomains) {
  const special = /[\.\|\?\+\^\$\(\)\[\]\{\}\\]/g;
  const subdomains = matchSubdomains ? '([^/]*\\.)?' : '(www\\.)?';
  return (
    subdomains +
    pattern
      .replace(special, '\\$&')
      .replace(/[\u0080-\uFFFF]/g, encodeURIComponent)
      .replace(/^www\\\./, '')
      .replace(/\*\\\+/g, '.+')
      .replace(/\*{2,}/g, '.{STAR}')
      .replace(/\*/g, '[^\\/]{STAR}')
      .replace(/{STAR}/g, '*')
  );
}
