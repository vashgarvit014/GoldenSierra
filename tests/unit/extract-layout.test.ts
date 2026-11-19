import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/lib/ingest/extract';

/** Directory and job-board pages built from plain divs (ChamberMaster, Squarespace) keep their text. */
describe('page text extraction', () => {
  const page = (main: string) => `<html><body><nav><a href="/x">Menu</a></nav><main>${main}</main></body></html>`;

  it('keeps names and descriptions that live in plain divs and links', () => {
    const t = parseHtml(page(`<h1>Job Search</h1>
      <div class="mn-listing"><div class="mn-title"><a href="/m/1">El Dorado Irrigation District</a></div>
        <div class="mn-job-title">Director of Finance</div><div class="mn-category">Category: Financial Services</div>
        <div class="mn-desc">Lead long-range financial planning.</div></div>
      <ul><li>(530) 622-4513</li></ul>`), 'https://example.org/jobs').text;
    for (const s of ['El Dorado Irrigation District', 'Director of Finance', 'Category: Financial Services', 'Lead long-range financial planning.', '- (530) 622-4513', '# Job Search']) expect(t).toContain(s);
    expect(t).not.toContain('Menu');
  });

  it('never glues adjacent blocks together and never repeats nested text', () => {
    const t = parseHtml(page(`<ul><li><p>Hope Valley Campground</p><p>Desolation Hotel</p></li></ul><p>Alpha<br>Beta</p>`), 'https://example.org/').text;
    expect(t).not.toMatch(/CampgroundDesolation|AlphaBeta/);
    expect(t.match(/Desolation Hotel/g)).toHaveLength(1);
  });
});
