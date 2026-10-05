import { normalizeCode, uniqueCodes } from './tracking-codes';

describe('tracking codes', () => {
  it('normalises case and whitespace', () => {
    expect(normalizeCode('  em123456789in ')).toBe('EM123456789IN');
  });
  it('dedupes in first-seen order and drops blanks', () => {
    expect(uniqueCodes(['b1', ' A1', '', 'B1 ', 'a1', 'c1'])).toEqual([
      'B1',
      'A1',
      'C1',
    ]);
  });
});
