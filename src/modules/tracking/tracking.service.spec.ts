import { BadRequestException } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import {
  IndiaPostApiService,
  IndiaPostArticle,
} from './india-post-api.service';

/**
 * The sample Bulk Tracking response from India Post's integration document,
 * reproduced verbatim (scans newest-first, as they send them).
 */
const SAMPLE: IndiaPostArticle = {
  booking_details: {
    article_number: 'RK775227016IN',
    booked_at: 'Changanacherry HO',
    booked_on: '2026-09-05T23:24:16.038+05:30',
    origin_pincode: '686101',
    destination_pincode: '689694',
    tariff: 42.63,
    article_type: 'SP_INLAND_PARCEL',
    delivery_location: 'Kalanjoor SO',
    delivery_confirmed_on: null,
  },
  tracking_details: [
    {
      date: '2026-09-07T15:24:12Z',
      time: '15:24:12',
      office: 'Kalanjoor SO',
      officeid: '22660021',
      event: 'Item Kept on Hold',
      remarks: 'Intimation Delivered',
      rts: false,
    },
    {
      date: '2026-09-07T12:56:46.613Z',
      time: '12:56:46',
      office: 'Kalanjoor SO',
      officeid: '22660021',
      event: 'Taken out for delivery',
      remarks: '',
      rts: false,
    },
    {
      date: '2026-09-05T23:24:16.038Z',
      time: '23:24:16',
      office: 'Changanacherry HO',
      officeid: '22360017',
      event: 'Item Booked',
      remarks: '',
      rts: false,
    },
  ],
  del_status: { del_status: 'not delivered' },
};

function makeService(articles: IndiaPostArticle[]) {
  const api = { trackBulk: jest.fn().mockResolvedValue(articles) };
  return {
    service: new TrackingService(api as unknown as IndiaPostApiService),
    api,
  };
}

describe('TrackingService', () => {
  it('maps a booked-and-scanned article from the India Post payload', async () => {
    const { service, api } = makeService([SAMPLE]);
    const result = await service.track('rk775227016in');

    expect(api.trackBulk).toHaveBeenCalledWith(['RK775227016IN']);
    expect(result.found).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.source).toBe('India Post');

    // Scans arrive newest-first; we store them oldest-first so events[0] is the
    // booking and the last entry is the current state.
    expect(result.events.map((e) => e.event)).toEqual([
      'Item Booked',
      'Taken out for delivery',
      'Item Kept on Hold',
    ]);
    expect(result.currentStatus).toBe('Item Kept on Hold');
    expect(result.currentStatusType).toBe('ItemKeptOnHold');
    expect(result.lastUpdatedAt).toBe('2026-09-07T15:24:12Z');
    expect(result.bookedAt).toBe('2026-09-05T23:24:16.038+05:30');

    expect(result.articleType).toBe('SP_INLAND_PARCEL');
    expect(result.deliveryLocation).toBe('Kalanjoor SO');
    expect(result.bookedAtOffice).toBe('Changanacherry HO');
    expect(result.originPincode).toBe('686101');
    expect(result.destinationPincode).toBe('689694');
    expect(result.tariff).toBe(42.63);
    expect(result.returnToSender).toBe(false);
  });

  it('does not read "not delivered" as delivered', async () => {
    const { service } = makeService([SAMPLE]);
    const result = await service.track('RK775227016IN');
    expect(result.delivered).toBe(false);
    expect(result.deliveredAt).toBeNull();
  });

  it('marks an article delivered from del_status, confirmation or a scan', async () => {
    const delivered: IndiaPostArticle = {
      ...SAMPLE,
      booking_details: {
        ...SAMPLE.booking_details!,
        delivery_confirmed_on: '2026-09-08T10:15:00Z',
      },
      tracking_details: [
        {
          date: '2026-09-08T10:15:00Z',
          time: '10:15:00',
          office: 'Kalanjoor SO',
          officeid: '22660021',
          event: 'Item Delivered',
          remarks: '',
          rts: false,
        },
        ...SAMPLE.tracking_details!,
      ],
      del_status: { del_status: 'delivered' },
    };
    const { service } = makeService([delivered]);
    const result = await service.track('RK775227016IN');

    expect(result.delivered).toBe(true);
    expect(result.deliveredAt).toBe('2026-09-08T10:15:00Z');
    expect(result.currentStatus).toBe('Item Delivered');
  });

  it('flags a return to sender', async () => {
    const rts: IndiaPostArticle = {
      ...SAMPLE,
      tracking_details: [
        {
          date: '2026-09-09T09:00:00Z',
          time: '09:00:00',
          office: 'Kalanjoor SO',
          officeid: '22660021',
          event: 'Item Returned to Sender',
          remarks: 'Addressee not available',
          rts: true,
        },
        ...SAMPLE.tracking_details!,
      ],
    };
    const { service } = makeService([rts]);
    const result = await service.track('RK775227016IN');

    expect(result.returnToSender).toBe(true);
    expect(result.delivered).toBe(false);
  });

  it('reports a booking with no scans as partial', async () => {
    const { service } = makeService([
      { booking_details: SAMPLE.booking_details, tracking_details: [] },
    ]);
    const result = await service.track('RK775227016IN');

    expect(result.found).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.currentStatus).toBe('Booked — awaiting first scan');
    expect(result.message).toMatch(/no scans/i);
  });

  it('reports an article India Post does not know as not found', async () => {
    // India Post omits unknown articles from the response entirely.
    const { service } = makeService([]);
    const result = await service.track('EN455305586IN');

    expect(result.available).toBe(true);
    expect(result.found).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.message).toMatch(/booked under our customer id/i);
  });

  it('keeps bulk results aligned with the numbers asked for', async () => {
    const { service } = makeService([SAMPLE]);
    const results = await service.trackMany(['EN455305586IN', 'RK775227016IN']);

    expect(results.map((r) => r.consignmentNumber)).toEqual([
      'EN455305586IN',
      'RK775227016IN',
    ]);
    expect(results[0].found).toBe(false);
    expect(results[1].found).toBe(true);
  });

  it('rejects a malformed consignment number before calling India Post', async () => {
    const { service, api } = makeService([]);
    await expect(service.track('12345')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(api.trackBulk).not.toHaveBeenCalled();
  });
});

/**
 * Shapes captured from the LIVE UAT API, which differs from the document:
 * `date` is midnight-truncated with the real clock in `time`, `officeid` is a
 * number, `remarks`/`rts` are absent, `tariff` is 0, and an article India Post
 * knows nothing about is echoed back blank rather than omitted.
 */
describe('TrackingService — live API shapes', () => {
  const LIVE_TRACKED: IndiaPostArticle = {
    booking_details: {
      article_number: 'EY011867595IN',
      booked_at: 'Tambaram HO',
      booked_on: '2026-02-19T17:16:05.817Z',
      origin_pincode: '',
      destination_pincode: '600052',
      tariff: 0,
      article_type: 'SP_INLAND_DOC',
      delivery_location: 'Redhills SO',
      delivery_confirmed_on: null,
    },
    tracking_details: [
      {
        date: '2026-02-19T00:00:00Z',
        time: '17:44:15',
        office: 'Tambaram HO',
        officeid: 29360016,
        event: 'Item Bagged',
      },
      {
        date: '2026-02-19T00:00:00Z',
        time: '18:20:45',
        office: 'Redhills SO',
        officeid: 29660408,
        event: 'Item Received',
      },
    ],
    del_status: { del_status: 'not delivered' },
  };

  // Echoed back with everything blank — this is how "we have nothing" arrives.
  const LIVE_UNKNOWN: IndiaPostArticle = {
    booking_details: {
      article_number: 'EN455305586IN',
      booked_at: '',
      booked_on: null,
      origin_pincode: '',
      destination_pincode: '',
      tariff: 0,
      article_type: '',
      delivery_location: '',
      delivery_confirmed_on: null,
    },
    tracking_details: [],
    del_status: { del_status: 'not delivered' },
  };

  it('rebuilds each scan time from the separate date and time fields', async () => {
    const { service } = makeService([LIVE_TRACKED]);
    const result = await service.track('EY011867595IN');

    // Without this the whole day collapses to 00:00 and same-day scans tie.
    expect(result.events.map((e) => e.timestamp)).toEqual([
      '2026-02-19T17:44:15Z',
      '2026-02-19T18:20:45Z',
    ]);
    expect(result.lastUpdatedAt).toBe('2026-02-19T18:20:45Z');
    expect(result.currentStatus).toBe('Item Received');
  });

  it('tolerates a numeric officeid and missing remarks/rts', async () => {
    const { service } = makeService([LIVE_TRACKED]);
    const result = await service.track('EY011867595IN');

    expect(result.events[0].pincode).toBe('29360016');
    expect(result.events[0].remarks).toBe('');
    expect(result.returnToSender).toBe(false);
  });

  it('omits a zero tariff rather than reporting ₹0', async () => {
    const { service } = makeService([LIVE_TRACKED]);
    const result = await service.track('EY011867595IN');
    expect(result.tariff).toBeUndefined();
  });

  it('treats an echoed-but-blank article as not found', async () => {
    const { service } = makeService([LIVE_UNKNOWN]);
    const result = await service.track('EN455305586IN');

    // The booking_details object exists; its emptiness is the signal.
    expect(result.found).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.currentStatus).toBe('No tracking information found yet');
  });

  it('still reports scans when booking_details comes back blank', async () => {
    const { service } = makeService([
      {
        booking_details: {
          ...LIVE_UNKNOWN.booking_details!,
          article_number: 'RK440375064IN',
        },
        tracking_details: [
          {
            date: '2025-06-25T00:00:00Z',
            time: '13:35:26',
            office: 'Mudhol S.O',
            officeid: 21660269,
            event: 'Item Delivered to senior court',
          },
        ],
        del_status: { del_status: 'delivered' },
      },
    ]);
    const result = await service.track('RK440375064IN');

    expect(result.found).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.bookedAt).toBe('2025-06-25T13:35:26Z');
  });
});
