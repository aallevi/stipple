import { describe, expect, it } from 'vitest';
import { compactSVG } from '../src/export/light';

const sample = [
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
  '<defs>',
  '<g id="sh_circle">',
  '<circle cx="0" cy="0" r="0.42"/>',
  '</g>',
  '</defs>',
  '<g id="a" data-name="One ink" transform="translate(0 0)" opacity="1">',
  '<use xlink:href="#sh_circle" transform="translate(12.345 0.06) scale(0.4567)" fill="#000000"/>',
  '<use xlink:href="#sh_circle" transform="translate(3.21 -4.04) rotate(12.345) scale(2.5)" fill="#000000" fill-opacity="0.12345"/>',
  '</g>',
  '<g id="b" data-name="Two inks" transform="translate(0 0)" opacity="1">',
  '<use xlink:href="#sh_circle" transform="translate(1 1) scale(1)" fill="#ff0000"/>',
  '<use xlink:href="#sh_circle" transform="translate(2 2) scale(1)" fill="#0000ff"/>',
  '</g>',
  '</svg>',
].join('\n');

describe('compact SVG', () => {
  const out = compactSVG(sample);

  it('rounds positions to a tenth but keeps a small dot’s size to three figures', () => {
    expect(out).toContain('translate(12.3 .1) scale(.457)');
    expect(out).toContain('rotate(12.3) scale(2.5)');
    expect(out).toContain('fill-opacity=".123"');
  });

  it('says a shared colour once, on the layer', () => {
    expect(out).toContain('data-name="One ink" transform="translate(0 0)" opacity="1" fill="#000">');
    expect(out.match(/fill="#000"/g)).toHaveLength(1);
  });

  it('leaves the colours alone on a layer whose dots differ', () => {
    expect(out).toContain('fill="#f00"');
    expect(out).toContain('fill="#00f"');
  });

  it('renames the shapes, everywhere they are named', () => {
    expect(out).not.toContain('sh_circle');
    expect(out).toContain('id="s0"');
    expect(out.match(/href="#s0"/g)).toHaveLength(4);
  });

  it('keeps the shape geometry exact, and drops the space between tags', () => {
    expect(out).toContain('r="0.42"');
    expect(out).not.toMatch(/>\s+</);
  });
});
