import {
  classify,
  lookupCondition,
  parseLookup,
  unmatchedValues,
} from './order-lookup';

describe('order lookup (advanced search)', () => {
  it('classifies each kind of value', () => {
    expect(classify('+91 98765 43210')).toMatchObject({
      kind: 'phone',
      value: '9876543210',
    });
    expect(classify('09876543210')).toMatchObject({
      kind: 'phone',
      value: '9876543210',
    });
    expect(classify('919876543210')).toMatchObject({
      kind: 'phone',
      value: '9876543210',
    });
    expect(classify('ea123456789in')).toMatchObject({
      kind: 'tracking',
      value: 'EA123456789IN',
    });
    expect(classify('6ACF8856D7243D041D455299')).toMatchObject({
      kind: 'orderId',
      value: '6acf8856d7243d041d455299',
    });
    expect(classify('#1D455299')).toMatchObject({
      kind: 'shortId',
      value: '1d455299',
    });
    expect(classify('Asha@Example.com')).toMatchObject({
      kind: 'email',
      value: 'asha@example.com',
    });
    expect(classify('500034')).toMatchObject({ kind: 'pincode' });
    expect(classify('1234567890')).toBeNull(); // not a mobile
    expect(classify('hello')).toBeNull();
  });

  it('splits on lines, commas, spaces — keeping spaced phone numbers whole — and dedupes', () => {
    const { tokens, unknown } = parseLookup(
      '+91 98765 43210\n9876543210, EA123456789IN EA123456789IN;nope\t500034',
    );
    expect(tokens.map((t) => `${t.kind}:${t.value}`)).toEqual([
      'phone:9876543210',
      'tracking:EA123456789IN',
      'pincode:500034',
    ]);
    expect(unknown).toEqual(['nope']);
    // Spaces split anything that isn't purely a phone number.
    expect(
      parseLookup('a@b.co 9000000000 junk').tokens.map((t) => t.kind),
    ).toEqual(['email', 'phone']);
  });

  it('builds one $or covering every kind', () => {
    const cond: any = lookupCondition(
      parseLookup('9876543210 EA123456789IN 1d455299').tokens,
    );
    expect(cond.$or).toHaveLength(3);
    const phoneRe: RegExp = cond.$or[0]['shippingAddress.phone'].$in[0];
    expect(phoneRe.test('+91 98765 43210')).toBe(true);
    expect(phoneRe.test('98765432100')).toBe(false); // must END with the number
    expect(lookupCondition([])).toBeNull();
  });

  it('reports the values no order carries', () => {
    const { tokens } = parseLookup(
      '9876543210 9000000000 EA123456789IN 1d455299 500001',
    );
    const orders = [
      {
        _id: '6acf8856d7243d041d455299',
        trackingNumber: ' ea123456789in',
        shippingAddress: { phone: '+91 98765-43210', pincode: 500034 },
      },
    ];
    expect(unmatchedValues(tokens, orders)).toEqual(['9000000000', '500001']);
  });
});
