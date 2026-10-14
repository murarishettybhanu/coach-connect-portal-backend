import { parseLooseJson } from './postal-body';

describe('parseLooseJson', () => {
  it('reads JSON whatever it was labelled', () => {
    expect(parseLooseJson('{"article_number":"CA1IN"}')).toEqual({
      article_number: 'CA1IN',
    });
    expect(parseLooseJson('  [{"a":1}]  ')).toEqual([{ a: 1 }]);
  });
  it('finds JSON inside a form field', () => {
    const form = `payload=${encodeURIComponent('{"article_number":"CA1IN"}')}&x=1`;
    expect(parseLooseJson(form)).toEqual({ article_number: 'CA1IN' });
  });
  it('is undefined for anything that is not JSON', () => {
    expect(parseLooseJson('')).toBeUndefined();
    expect(parseLooseJson('hello')).toBeUndefined();
    expect(parseLooseJson('a=b&c=d')).toBeUndefined();
  });
});
