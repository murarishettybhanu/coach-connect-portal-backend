import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Types } from 'mongoose';
import { EnquiriesService } from './enquiries.service';
import { AdminEnquiriesController } from './enquiries.controller';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../../schemas/user.schema';
import { EnquiryStatus } from '../../schemas/enquiry.schema';

const query = (value: any) => {
  const q: any = {
    exec: jest.fn().mockResolvedValue(value),
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => q,
  };
  return q;
};

const ID = String(new Types.ObjectId());

function setup() {
  const model: any = {
    countDocuments: jest.fn(() => query(2)),
    find: jest.fn(() => query([{ name: 'Priya' }])),
    findById: jest.fn(() => query({ _id: ID, status: EnquiryStatus.NEW })),
    findOneAndUpdate: jest.fn(() => query({ _id: ID, seenAt: new Date() })),
    findByIdAndUpdate: jest.fn(() => query({ _id: ID })),
  };
  return { model, service: new EnquiriesService(model) };
}

describe('EnquiriesService unread tracking', () => {
  it('counts only NEW enquiries nobody has opened, newest few for the pop-ups', async () => {
    const { model, service } = setup();
    await expect(service.unread()).resolves.toEqual({
      count: 2,
      latest: [{ name: 'Priya' }],
    });
    const unread = { status: EnquiryStatus.NEW, seenAt: { $exists: false } };
    expect(model.countDocuments).toHaveBeenCalledWith(unread);
    expect(model.find).toHaveBeenCalledWith(unread);
  });

  it('opening marks it seen once — the first open time is kept', async () => {
    const { model, service } = setup();
    await service.markSeen(ID);
    const [filter, update] = model.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: ID, seenAt: { $exists: false } });
    expect(update.$set.seenAt).toBeInstanceOf(Date);

    // Already seen: no write matches; it's returned as it is.
    model.findOneAndUpdate.mockReturnValue(query(null));
    await expect(service.markSeen(ID)).resolves.toMatchObject({ _id: ID });
  });

  it('changing the status (e.g. to CONTACTED) also clears unread', async () => {
    const { model, service } = setup();
    await service.update(ID, { status: EnquiryStatus.CONTACTED });
    const [, update] = model.findByIdAndUpdate.mock.calls[0];
    expect(update.$set.status).toBe(EnquiryStatus.CONTACTED);
    expect(update.$set.seenAt).toBeInstanceOf(Date);

    // An enquiry opened earlier keeps its first-seen time.
    model.findById.mockReturnValue(query({ _id: ID, seenAt: new Date(0) }));
    await service.update(ID, { status: EnquiryStatus.CLOSED });
    expect(model.findByIdAndUpdate.mock.calls[1][1].$set).toEqual({
      status: EnquiryStatus.CLOSED,
    });
  });

  it('404s an unknown or malformed enquiry', async () => {
    const { model, service } = setup();
    await expect(service.markSeen('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    model.findOneAndUpdate.mockReturnValue(query(null));
    model.findById.mockReturnValue(query(null));
    await expect(service.markSeen(ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.update(ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminEnquiriesController', () => {
  it.each([
    [UserRole.ADMIN, true],
    [UserRole.TRIBE, false],
  ])('the unread feed is admin only (%s → %s)', (role, allowed) => {
    const guard = new RolesGuard(new Reflector());
    const ctx: any = {
      getHandler: () => AdminEnquiriesController.prototype.unread,
      getClass: () => AdminEnquiriesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    };
    expect(guard.canActivate(ctx)).toBe(allowed);
  });
});
