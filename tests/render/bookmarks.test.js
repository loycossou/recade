import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeLink } from '../../src/render/bookmarks.js';

test('isSafeLink accepts anchors, http(s), mailto and tel, and nothing else', () => {
  for (const ok of ['#scope', 'https://example.org/x', 'HTTP://example.org', 'mailto:someone' + String.fromCharCode(64) + 'example.org', 'tel:+33123456789']) assert.equal(isSafeLink(ok), true, ok);
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', '//evil.example', '', undefined, null]) assert.equal(isSafeLink(bad), false, String(bad));
});
