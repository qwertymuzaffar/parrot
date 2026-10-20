import { escapeHtml } from './html';

describe('escapeHtml', () => {
  it('escapes the characters that would start markup or end an attribute', () => {
    expect(escapeHtml('<b class="x">Tom & Jerry</b>')).toBe('&lt;b class=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/b&gt;');
  });

  it('leaves plain text, apostrophes and curly quotes alone', () => {
    expect(escapeHtml("it’s “fine”, isn't it")).toBe("it’s “fine”, isn't it");
  });
});
