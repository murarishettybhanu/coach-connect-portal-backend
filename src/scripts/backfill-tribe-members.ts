/**
 * Builds the `tribemembers` collection from existing orders and links every
 * order to its member (`Order.memberId`). Idempotent: a second run reports no
 * changes. Prints summary counts only — never names, phones or addresses.
 *
 *   MONGODB_URI=... npx ts-node src/scripts/backfill-tribe-members.ts --dry-run
 *   MONGODB_URI=... npx ts-node src/scripts/backfill-tribe-members.ts
 *
 * (Also compiled by `nest build`: `node dist/scripts/backfill-tribe-members.js`.)
 *
 * Writes are additive only: members in the new collection (plus its indexes),
 * and `$set: { memberId }` on orders — no other order field, not even
 * updatedAt. Connects with Mongoose directly, so it needs nothing but
 * MONGODB_URI. No transactions (standalone mongod in dev); a run that stops
 * half way is finished by running it again.
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { Order, OrderSchema } from '../schemas/order.schema';
import { Tribe, TribeSchema } from '../schemas/tribe.schema';
import { TribeMember, TribeMemberSchema } from '../schemas/tribe-member.schema';
import { TribeMembersService } from '../modules/tribe-members/tribe-members.service';
import {
  buildMemberFields,
  normalizePhone,
  sameMemberFields,
} from '../modules/tribe-members/member-fields';

interface Group {
  coachId: any;
  phone: string;
  orders: any[];
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  // autoIndex off: the app builds Order's indexes on boot; this script only
  // creates the new collection's own indexes, and only on a real run.
  const conn = await mongoose
    .createConnection(uri, { autoIndex: false })
    .asPromise();
  try {
    const orders = conn.model<Order>(Order.name, OrderSchema);
    const members = conn.model<TribeMember>(
      TribeMember.name,
      TribeMemberSchema,
    );
    // The tribe model is only used by the API's TRIBE-scoped reads, never here.
    const tribes = conn.model<Tribe>(Tribe.name, TribeSchema);
    const svc = new TribeMembersService(members, orders, tribes);

    console.log(
      `Tribe members backfill — ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'} on database "${conn.name}"`,
    );

    // Chronological, so the latest contact details and addresses win.
    const all: any[] = await orders
      .find({})
      .select(
        'coachId shippingAddress createdAt isDeleted addressPending memberId',
      )
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec();

    const groups = new Map<string, Group>();
    let skipped = 0;
    for (const o of all) {
      const phone = normalizePhone(o.shippingAddress?.phone);
      if (!phone || !o.coachId) {
        skipped++;
        continue;
      }
      const key = `${String(o.coachId)}|${phone}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { coachId: o.coachId, phone, orders: [] }));
      g.orders.push(o);
    }

    const existing = new Map<string, any>();
    for (const m of await members.find({}).lean().exec()) {
      existing.set(`${String(m.coachId)}|${m.phone}`, m);
    }

    const tally = {
      membersCreated: 0,
      membersUpdated: 0,
      membersUnchanged: 0,
      membersRemoved: 0,
      ordersLinked: 0,
      ordersAlreadyLinked: 0,
    };

    if (dryRun) {
      for (const [key, g] of groups) {
        const m = existing.get(key);
        if (!m) tally.membersCreated++;
        else if (sameMemberFields(m, buildMemberFields(g.orders)))
          tally.membersUnchanged++;
        else tally.membersUpdated++;
        for (const o of g.orders) {
          if (m && o.memberId && String(o.memberId) === String(m._id))
            tally.ordersAlreadyLinked++;
          else tally.ordersLinked++;
        }
      }
      // Members no order maps to any more (every order's phone changed).
      for (const key of existing.keys())
        if (!groups.has(key)) tally.membersRemoved++;
    } else {
      await members.createIndexes();
      const previousMembers = new Set<string>();
      for (const g of groups.values()) {
        const { member, created } = await svc.upsertMember(g.coachId, g.phone);
        if (created) tally.membersCreated++;

        const toLink = g.orders.filter(
          (o) => !o.memberId || String(o.memberId) !== String(member._id),
        );
        tally.ordersAlreadyLinked += g.orders.length - toLink.length;
        for (const o of toLink)
          if (o.memberId) previousMembers.add(String(o.memberId));
        if (toLink.length) {
          const res = await orders
            .updateMany(
              { _id: { $in: toLink.map((o) => o._id) } } as any,
              { $set: { memberId: member._id } },
              { timestamps: false },
            )
            .exec();
          tally.ordersLinked += res.modifiedCount;
        }

        const outcome = await svc.syncMember(member._id);
        if (!created) {
          if (outcome === 'updated') tally.membersUpdated++;
          else if (outcome === 'unchanged') tally.membersUnchanged++;
        }
      }

      // Members that lost orders above, and any no order maps to any more.
      const current = new Set<string>();
      for (const g of groups.values()) {
        const m: any = await members
          .findOne({ coachId: g.coachId, phone: g.phone })
          .select('_id')
          .lean();
        if (m) current.add(String(m._id));
      }
      for (const m of existing.values()) previousMembers.add(String(m._id));
      for (const id of previousMembers) {
        if (current.has(id)) continue;
        if ((await svc.syncMember(id)) === 'deleted') tally.membersRemoved++;
      }
    }

    const row = (label: string, n: number) =>
      console.log(`${label.padEnd(30)}${n}`);
    const verb = (dry: string, live: string) => (dryRun ? dry : live);
    row('Orders scanned', all.length);
    row('  skipped (no tribe/phone)', skipped);
    row('Members (tribe + phone)', groups.size);
    row(`  ${verb('to create', 'created')}`, tally.membersCreated);
    row(`  ${verb('to update', 'updated')}`, tally.membersUpdated);
    row('  unchanged', tally.membersUnchanged);
    row(
      `  ${verb('to remove', 'removed')} (no orders left)`,
      tally.membersRemoved,
    );
    row(`Orders ${verb('to link', 'linked')}`, tally.ordersLinked);
    row('  already linked', tally.ordersAlreadyLinked);

    if (!dryRun) {
      row(
        'Orders without a member now',
        await orders.countDocuments({ memberId: { $exists: false } } as any),
      );
      row('  (expected: the skipped ones)', skipped);
      row('Members in collection now', await members.countDocuments());
    }
    const changes =
      tally.membersCreated +
      tally.membersUpdated +
      tally.membersRemoved +
      tally.ordersLinked;
    console.log(
      changes ? `Changes: ${changes}` : 'No changes — already up to date.',
    );
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  // Server errors (E11000, validation, cast) quote document values — phones
  // included — so only connection problems get their message printed.
  const name = String(err?.name ?? 'Error');
  const safe =
    /^Mongo(ServerSelection|Network|Parse)Error$/.test(name) ||
    err?.code === 18;
  console.error(
    `Backfill failed: ${name}${err?.code != null ? ` (code ${err.code})` : ''}` +
      (safe
        ? `: ${err?.message}`
        : ' — details withheld; re-run with --dry-run to check counts'),
  );
  process.exit(1);
});
