import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DEFAULTS } from '../src/config.mjs';
import { explainAnalysisEligibility } from '../src/rules.mjs';
import { extractPage } from '../src/extract.mjs';

test('escaped privacy and search routes are excluded before page content can reach AI', () => {
  for (const [url, code] of [
    ['https://www.zhihu.com/%6dessages', 'private-page'],
    ['https://www.zhihu.com/%6dessages/%ZZ', 'private-page'],
    ['https://x.com/i%2Fchat/123', 'private-page'],
    ['https://x.com/i%5cchat/123', 'private-page'],
    ['https://www.youtube.com/%70laylist?list=WL', 'private-page'],
    ['https://space.bilibili.com/123/%66avlist', 'private-page'],
    ['https://www.zhihu.com/%73earch?q=private', 'search-results'],
    ['https://www.zhihu.com/%73earch/%E0%A4%A', 'search-results'],
    ['https://www.youtube.com/%72esults?search_query=private', 'search-results'],
    ['https://www.bilibili.com/%73earch?keyword=private', 'search-results'],
  ]) {
    const result = explainAnalysisEligibility(url, DEFAULTS);
    assert.equal(result.code, code, url);
    assert.equal(result.eligible, false, url);
  }
});

test('route decoding happens once and never interprets query data as a private or search route', () => {
  for (const url of [
    'https://www.zhihu.com/question/123?next=/%6dessages',
    'https://www.bilibili.com/video/BVexample/?keyword=search&next=/%73earch',
    'https://x.com/%6dessages-lab/status/123',
    'https://www.zhihu.com/%256dessages',
    'https://www.zhihu.com/%2573earch',
    'https://www.zhihu.com/question/123/%E0%A4%A',
  ])
    assert.equal(explainAnalysisEligibility(url, DEFAULTS).code, 'eligible', url);
});

test('video extraction rejects hidden or editable selected roots including title attributes', () => {
  for (const attributes of [
    'hidden',
    'aria-hidden="true"',
    'contenteditable',
    'style="display:none"',
    'style="visibility:hidden"',
  ]) {
    const dom = new JSDOM(
      `<title>公开标题</title><meta name="description" content="公开说明">
       <h1 class="video-title" title="私密标题属性" ${attributes}>私密标题文字</h1>
       <div id="v_desc" ${attributes}>私密草稿</div>
       <div class="video-tag-container"><span class="tag" ${attributes}>私密标签</span></div>`,
      { url: 'https://www.bilibili.com/video/BVexample/' }
    );
    const before = dom.window.document.documentElement.outerHTML;
    const page = extractPage(dom.window.document);
    assert.equal(page.title, '公开标题', attributes);
    assert.equal(page.excerpt, '公开说明', attributes);
    assert.equal(dom.window.document.documentElement.outerHTML, before);
    dom.window.close();
  }
});

test('video extraction retains private ancestor context until selected nodes are rejected', () => {
  for (const container of ['form', 'aside', 'section hidden', 'section contenteditable']) {
    const tag = container.split(' ')[0];
    const dom = new JSDOM(
      `<title>公开标题</title><meta name="description" content="公开说明">
       <${container}><h1 class="video-title" title="私密标题属性">私密标题文字</h1>
       <div id="v_desc">私密草稿</div></${tag}>`,
      { url: 'https://www.bilibili.com/video/BVexample/' }
    );
    const page = extractPage(dom.window.document);
    assert.equal(page.title, '公开标题', container);
    assert.equal(page.excerpt, '公开说明', container);
    dom.window.close();
  }
});
