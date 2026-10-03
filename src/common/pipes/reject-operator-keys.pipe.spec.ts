import { BadRequestException } from '@nestjs/common';
import {
  RejectOperatorKeysPipe,
  findOperatorKey,
} from './reject-operator-keys.pipe';

describe('RejectOperatorKeysPipe', () => {
  const pipe = new RejectOperatorKeysPipe();
  const body = (value: unknown) => pipe.transform(value, { type: 'body' });

  it.each([
    [{ $set: { role: 'ADMIN' } }],
    [{ status: 'PACKED', $unset: { password: 1 } }],
    [{ price: { $gt: 0 } }],
    [{ items: [{ productId: 'x', meta: { $where: 'sleep(1000)' } }] }],
    [{ 'items.$.price': 0 }],
    [{ 'a.$where': '1' }],
  ])('rejects operator keys anywhere in the body: %j', (value) => {
    expect(() => body(value)).toThrow(BadRequestException);
  });

  it('passes ordinary bodies through untouched', () => {
    const value = {
      name: 'Asha',
      shippingAddress: { pincode: '560001', line1: '12 MG Road' },
      items: [{ productId: 'p1', quantity: 2 }],
      // A dotted key is not an operator.
      'size.label': '32.5',
      note: 'costs $5',
    };
    expect(body(value)).toBe(value);
  });

  it('leaves a WhatsApp webhook payload alone', () => {
    const meta = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '106540352242922' },
                messages: [
                  {
                    id: 'wamid.X',
                    type: 'text',
                    text: { body: 'Is $set a thing? {"$gt": 1}' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(body(meta)).toBe(meta);
  });

  it('only inspects bodies', () => {
    const value = { $where: '1' };
    expect(pipe.transform(value, { type: 'query' })).toBe(value);
    expect(pipe.transform(value, { type: 'param' })).toBe(value);
  });

  it('ignores primitives, buffers and dates', () => {
    expect(findOperatorKey('$set')).toBeNull();
    expect(findOperatorKey(Buffer.from('{"$set":1}'))).toBeNull();
    expect(findOperatorKey(new Date())).toBeNull();
    expect(findOperatorKey(null)).toBeNull();
  });

  it('refuses absurdly deep nesting instead of walking it', () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 100; i++) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(() => body(root)).toThrow(BadRequestException);
  });
});
