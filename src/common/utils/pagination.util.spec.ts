import { MAX_PAGE_SIZE, pageSizeOf } from './pagination.util';

describe('pageSizeOf', () => {
  it('honours page sizes above the old 100/200 caps', () => {
    expect(pageSizeOf(200, 20)).toBe(200);
    expect(pageSizeOf('750', 20)).toBe(750);
  });

  it('falls back when the size is missing or unusable', () => {
    expect(pageSizeOf(undefined, 20)).toBe(20);
    expect(pageSizeOf('abc', 10)).toBe(10);
    expect(pageSizeOf(0, 10)).toBe(10);
  });

  it('clamps to 1..MAX_PAGE_SIZE and drops fractions', () => {
    expect(pageSizeOf(-5, 20)).toBe(1);
    expect(pageSizeOf(MAX_PAGE_SIZE + 1, 20)).toBe(MAX_PAGE_SIZE);
    expect(pageSizeOf(37.9, 20)).toBe(37);
  });
});
