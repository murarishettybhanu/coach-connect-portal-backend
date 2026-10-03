import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { WhatsappConversation } from '../../schemas/whatsapp-conversation.schema';
import { TribeMember } from '../../schemas/tribe-member.schema';
import { Tribe } from '../../schemas/tribe.schema';
import { WhatsappService } from './whatsapp.service';

/**
 * The phone part both sides can agree on. A conversation's contact is a
 * WhatsApp id ("919876543210"); members and owners store a 10-digit number,
 * sometimes formatted. India-only today, so the last 10 digits identify it.
 */
export const phoneKey = (v: unknown): string =>
  String(v ?? '')
    .replace(/\D/g, '')
    .slice(-10);

/** WhatsApp id for a 10-digit Indian number, for starting a conversation. */
const waIdOf = (phone: string) => (phone.length === 10 ? `91${phone}` : phone);

const tribeLabel = (t: any): string =>
  t?.userId?.name ||
  t?.name ||
  t?.brand ||
  (t?.username ? `@${t.username}` : 'Tribe');

/**
 * Groups the WhatsApp inbox by tribe: a conversation belongs to every tribe
 * whose owner or member has that number. Conversations matching nobody are
 * "other". Computed from current data on each call — at hundreds of
 * conversations and members this is a few small reads, no denormalisation.
 */
@Injectable()
export class WhatsappInboxService {
  constructor(
    @InjectModel(WhatsappConversation.name)
    private readonly conversationModel: Model<WhatsappConversation>,
    @InjectModel(TribeMember.name)
    private readonly memberModel: Model<TribeMember>,
    @InjectModel(Tribe.name)
    private readonly tribeModel: Model<Tribe>,
    private readonly whatsapp: WhatsappService,
  ) {}

  private async loadTribes() {
    return this.tribeModel
      .find()
      .select('name brand username userId')
      .populate({ path: 'userId', select: 'name phoneNumber' })
      .lean()
      .exec();
  }

  /** phone key → the tribe ids it belongs to (as owner or member). */
  private async phoneIndex(tribes: any[]) {
    const index = new Map<string, Set<string>>();
    const add = (phone: unknown, tribeId: unknown) => {
      const key = phoneKey(phone);
      if (key.length !== 10) return;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key)!.add(String(tribeId));
    };
    for (const t of tribes) add((t.userId as any)?.phoneNumber, t._id);
    const members = await this.memberModel
      .find()
      .select('coachId phone')
      .lean()
      .exec();
    for (const m of members) add(m.phone, m.coachId);
    return index;
  }

  /** Every tribe with its chat and unread counts, most recently active first, plus "other". */
  async summary() {
    const tribes = await this.loadTribes();
    const index = await this.phoneIndex(tribes);
    const conversations = await this.conversationModel
      .find()
      .select('contact unreadCount updatedAt')
      .lean()
      .exec();

    const stats = new Map<
      string,
      { chats: number; unread: number; last: number }
    >();
    const other = { chatCount: 0, unreadCount: 0 };
    for (const c of conversations) {
      const owners = index.get(phoneKey(c.contact));
      const unread = c.unreadCount || 0;
      if (!owners?.size) {
        other.chatCount++;
        other.unreadCount += unread;
        continue;
      }
      const at = new Date((c as any).updatedAt ?? 0).getTime();
      for (const id of owners) {
        const s = stats.get(id) ?? { chats: 0, unread: 0, last: 0 };
        s.chats++;
        s.unread += unread;
        s.last = Math.max(s.last, at);
        stats.set(id, s);
      }
    }

    const rows = tribes.map((t: any) => {
      const s = stats.get(String(t._id));
      const ownerPhone = phoneKey(t.userId?.phoneNumber);
      return {
        _id: String(t._id),
        name: tribeLabel(t),
        brand: t.brand ?? null,
        username: t.username ?? null,
        ownerName: t.userId?.name ?? null,
        ownerPhone: ownerPhone.length === 10 ? ownerPhone : null,
        chatCount: s?.chats ?? 0,
        unreadCount: s?.unread ?? 0,
        lastActivityAt: s?.last ? new Date(s.last) : null,
      };
    });
    // Active tribes first (newest chat), then the quiet ones by name.
    rows.sort(
      (a, b) =>
        (b.lastActivityAt?.getTime() ?? 0) -
          (a.lastActivityAt?.getTime() ?? 0) || a.name.localeCompare(b.name),
    );
    return { tribes: rows, other };
  }

  /** One tribe: its owner (with their conversation, if any) and members' conversations. */
  async tribe(tribeId: string) {
    if (!isValidObjectId(tribeId))
      throw new NotFoundException('Tribe not found');
    const tribe: any = await this.tribeModel
      .findById(tribeId)
      .select('name brand username userId')
      .populate({ path: 'userId', select: 'name phoneNumber' })
      .lean()
      .exec();
    if (!tribe) throw new NotFoundException('Tribe not found');

    const members = await this.memberModel
      .find({ coachId: tribe._id } as any)
      .select('name phone')
      .lean()
      .exec();
    const ownerPhone = phoneKey(tribe.userId?.phoneNumber);
    const keys = new Set<string>(members.map((m) => phoneKey(m.phone)));
    if (ownerPhone.length === 10) keys.add(ownerPhone);

    const byKey = await this.conversationsByKey(keys);

    const ownerConversation =
      ownerPhone.length === 10 ? (byKey.get(ownerPhone) ?? null) : null;
    const memberChats = members
      .map((m) => ({
        member: { _id: String(m._id), name: m.name || '', phone: m.phone },
        conversation: byKey.get(phoneKey(m.phone)),
      }))
      .filter((x) => x.conversation && x.conversation !== ownerConversation)
      .sort(
        (a, b) =>
          new Date((b.conversation as any).updatedAt ?? 0).getTime() -
          new Date((a.conversation as any).updatedAt ?? 0).getTime(),
      );

    return {
      tribe: {
        _id: String(tribe._id),
        name: tribeLabel(tribe),
        brand: tribe.brand ?? null,
        username: tribe.username ?? null,
      },
      owner: {
        name: tribe.userId?.name ?? null,
        phone: ownerPhone.length === 10 ? ownerPhone : null,
        // What to message to start a chat when there isn't one yet.
        contact: ownerPhone.length === 10 ? waIdOf(ownerPhone) : null,
        conversation: ownerConversation,
      },
      members: memberChats,
    };
  }

  /** Conversations whose number matches no tribe owner or member. */
  async other() {
    const index = await this.phoneIndex(await this.loadTribes());
    const conversations = await this.conversationModel
      .find()
      .sort({ updatedAt: -1 })
      .lean()
      .exec();
    return conversations
      .filter((c) => !index.get(phoneKey(c.contact))?.size)
      .map((c) => this.whatsapp.presentConversation(c));
  }

  /** The inbox conversations for these phone keys, presented, keyed by phone key. */
  private async conversationsByKey(keys: Set<string>) {
    const byKey = new Map<string, any>();
    if (!keys.size) return byKey;
    // Contacts are stored as WhatsApp ids; match the 10-digit tail of each.
    const pattern = new RegExp(`(${[...keys].join('|')})$`);
    const conversations = await this.conversationModel
      .find({ contact: pattern } as any)
      .lean()
      .exec();
    for (const c of conversations) {
      const key = phoneKey(c.contact);
      if (!keys.has(key)) continue;
      const prev = byKey.get(key);
      // Two ids with the same tail (rare): keep the more recent conversation.
      if (
        !prev ||
        new Date((c as any).updatedAt ?? 0) > new Date(prev.updatedAt ?? 0)
      ) {
        byKey.set(key, this.whatsapp.presentConversation(c));
      }
    }
    return byKey;
  }
}
