import {
  addressKey,
  buildMemberFields,
  memberUpdate,
  normalizePhone,
  sameMemberFields,
} from './member-fields';

const at = (day: number) => new Date(Date.UTC(2026, 0, day));
const addr = (extra: any = {}) => ({
  fullName: 'Ravi Kumar',
  phone: '9876543210',
  addressLine1: '1 MG Road',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
  ...extra,
});

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['+91-9876543210', '9876543210'],
    ['09876543210', '9876543210'],
    [' 98765-43210 ', '9876543210'],
    ['', ''],
    [undefined, ''],
    [null, ''],
  ])('%p → %p', (input, out) => {
    expect(normalizePhone(input)).toBe(out);
  });
});

describe('addressKey', () => {
  it('ignores case, outer and repeated whitespace', () => {
    expect(
      addressKey({ addressLine1: '  1  MG   road ', pincode: ' 411001' }),
    ).toBe(addressKey({ addressLine1: '1 mg ROAD', pincode: '411001' }));
  });
  it('differs by pincode', () => {
    expect(
      addressKey({ addressLine1: '1 MG Road', pincode: '411001' }),
    ).not.toBe(addressKey({ addressLine1: '1 MG Road', pincode: '411002' }));
  });
});

describe('buildMemberFields', () => {
  it('a single order makes a member with one address', () => {
    const f = buildMemberFields([
      {
        createdAt: at(1),
        shippingAddress: addr({ email: 'r@x.in', landmark: 'Temple' }),
      },
    ]);
    expect(f).toEqual({
      name: 'Ravi Kumar',
      email: 'r@x.in',
      alternatePhone: null,
      orderCount: 1,
      firstOrderAt: at(1),
      lastOrderAt: at(1),
      joinedAt: at(1),
      addresses: [
        {
          addressLine1: '1 MG Road',
          landmark: 'Temple',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
          lastUsedAt: at(1),
        },
      ],
    });
  });

  it('latest non-empty contact wins regardless of input order', () => {
    const f = buildMemberFields([
      {
        createdAt: at(3),
        shippingAddress: addr({ fullName: 'Ravi K', email: '' }),
      },
      {
        createdAt: at(1),
        shippingAddress: addr({
          email: 'old@x.in',
          alternatePhone: '9000000000',
        }),
      },
      { createdAt: at(2), shippingAddress: addr({ email: 'new@x.in' }) },
    ]);
    expect(f.name).toBe('Ravi K');
    expect(f.email).toBe('new@x.in');
    expect(f.alternatePhone).toBe('9000000000');
  });

  it('dedupes addresses loosely, keeps the latest spelling, newest first', () => {
    const f = buildMemberFields([
      {
        createdAt: at(1),
        shippingAddress: addr({ addressLine1: '1 mg road' }),
      },
      {
        createdAt: at(2),
        shippingAddress: addr({
          addressLine1: '22 Park St',
          pincode: '700016',
          city: 'Kolkata',
          state: 'WB',
        }),
      },
      {
        createdAt: at(3),
        shippingAddress: addr({ addressLine1: ' 1  MG Road ' }),
      },
    ]);
    expect(f.addresses.map((a) => [a.addressLine1, a.lastUsedAt])).toEqual([
      ['1  MG Road', at(3)],
      ['22 Park St', at(2)],
    ]);
  });

  it('counts only non-deleted orders, but keeps their contact and addresses', () => {
    const f = buildMemberFields([
      {
        createdAt: at(1),
        isDeleted: true,
        shippingAddress: addr({ addressLine1: 'Old house' }),
      },
      { createdAt: at(2), shippingAddress: addr() },
      {
        createdAt: at(5),
        isDeleted: true,
        shippingAddress: addr({ fullName: 'Ravi Deleted' }),
      },
    ]);
    expect(f.orderCount).toBe(1);
    expect(f.firstOrderAt).toEqual(at(2));
    expect(f.lastOrderAt).toEqual(at(2));
    expect(f.name).toBe('Ravi Deleted');
    expect(f.addresses).toHaveLength(2);
  });

  it('a member whose orders are all deleted has no count or dates', () => {
    const f = buildMemberFields([
      { createdAt: at(1), isDeleted: true, shippingAddress: addr() },
    ]);
    expect(f.orderCount).toBe(0);
    expect(f.firstOrderAt).toBeNull();
    expect(f.lastOrderAt).toBeNull();
  });

  it('address-pending orders add contact but no address', () => {
    const f = buildMemberFields([
      {
        createdAt: at(1),
        addressPending: true,
        shippingAddress: { fullName: 'Asha', phone: '9876543210' },
      },
    ]);
    expect(f.name).toBe('Asha');
    expect(f.addresses).toEqual([]);
    expect(f.orderCount).toBe(1);
  });

  it('an incomplete address is not an address', () => {
    const f = buildMemberFields([
      { createdAt: at(1), shippingAddress: addr({ pincode: '' }) },
    ]);
    expect(f.addresses).toEqual([]);
  });
});

describe('sameMemberFields / memberUpdate', () => {
  it('a stored member equal to the computed one is unchanged', () => {
    const f = buildMemberFields([
      { createdAt: at(1), shippingAddress: addr() },
    ]);
    // As a lean Mongoose read returns it: absent optionals, extra keys.
    const stored = {
      _id: 'x',
      __v: 3,
      coachId: 'c',
      phone: '9876543210',
      name: 'Ravi Kumar',
      orderCount: 1,
      firstOrderAt: at(1),
      lastOrderAt: at(1),
      joinedAt: at(1),
      addresses: [{ ...f.addresses[0] }],
    };
    expect(sameMemberFields(stored, f)).toBe(true);
    expect(sameMemberFields({ ...stored, orderCount: 2 }, f)).toBe(false);
    expect(sameMemberFields({ ...stored, email: 'a@b.c' }, f)).toBe(false);
    expect(sameMemberFields({ ...stored, joinedAt: at(2) }, f)).toBe(false);
  });

  it('joinedAt is the earliest linked order, deleted ones included', () => {
    const f = buildMemberFields([
      { createdAt: at(3), shippingAddress: addr() },
      { createdAt: at(1), isDeleted: true, shippingAddress: addr() },
    ]);
    expect(f.joinedAt).toEqual(at(1));
    expect(f.firstOrderAt).toEqual(at(3));
  });

  it('unsets the optional fields that are now empty', () => {
    const f = buildMemberFields([
      { createdAt: at(1), isDeleted: true, shippingAddress: addr() },
    ]);
    expect(memberUpdate(f)).toEqual({
      $set: {
        name: 'Ravi Kumar',
        addresses: f.addresses,
        orderCount: 0,
        joinedAt: at(1),
      },
      $unset: { email: 1, alternatePhone: 1, firstOrderAt: 1, lastOrderAt: 1 },
    });
  });
});
