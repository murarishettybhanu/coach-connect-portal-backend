import { titleCaseName } from './name.util';

describe('titleCaseName', () => {
  it('fixes the two ways names actually arrive', () => {
    expect(titleCaseName('RAVI KUMAR')).toBe('Ravi Kumar');
    expect(titleCaseName('ravi kumar')).toBe('Ravi Kumar');
  });

  it('tidies stray whitespace', () => {
    expect(titleCaseName('  ravi   kumar  ')).toBe('Ravi Kumar');
  });

  it('capitalises after hyphens, apostrophes and initials', () => {
    expect(titleCaseName('sri-ram')).toBe('Sri-Ram');
    expect(titleCaseName("d'souza")).toBe("D'Souza");
    expect(titleCaseName('d’souza')).toBe('D’Souza');
    expect(titleCaseName('k.v. ramana')).toBe('K.V. Ramana');
  });

  it('keeps dotless initials as initials', () => {
    // Real production names: "ARUN NN" must not become "Arun Nn".
    expect(titleCaseName('ARUN NN')).toBe('Arun NN');
    expect(titleCaseName('U GIRISH BABU')).toBe('U Girish Babu');
    expect(titleCaseName('KV RAMANA')).toBe('KV Ramana');
  });

  it('leaves a deliberately-cased word alone', () => {
    expect(titleCaseName('Ronan McDonald')).toBe('Ronan McDonald');
    expect(titleCaseName('priya DeSouza')).toBe('Priya DeSouza');
  });

  it('passes through scripts without letter case', () => {
    expect(titleCaseName('రవి కుమార్')).toBe('రవి కుమార్');
  });

  it('returns empty for nothing, so callers can fall back', () => {
    expect(titleCaseName('')).toBe('');
    expect(titleCaseName('   ')).toBe('');
    expect(titleCaseName(undefined)).toBe('');
    expect(titleCaseName(null)).toBe('');
  });
});
