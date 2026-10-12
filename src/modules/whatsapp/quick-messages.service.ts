import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { WhatsappConversation } from '../../schemas/whatsapp-conversation.schema';
import { TribeMember } from '../../schemas/tribe-member.schema';
import { Tribe } from '../../schemas/tribe.schema';
import { Order } from '../../schemas/order.schema';
import { WhatsappService } from './whatsapp.service';
import { phoneKey } from './whatsapp-inbox.service';
import {
  QUICK_CATEGORIES,
  QUICK_MESSAGES,
  limitProblems,
  unavailableReason,
  type QuickContext,
} from './quick-messages';

const STATUS_TEXT: Record<string, string> = {
  NEW: 'Order received — being prepared',
  PACKED: 'Packed and ready to ship',
  DISPATCHED: 'Shipped — on its way with India Post',
  DELIVERED: 'Delivered',
  RETURNED: 'Returned to us',
  CANCELLED: 'Cancelled',
};

const firstNameOf = (name?: string | null) => {
  const first =
    String(name ?? '')
      .trim()
      .split(/\s+/)[0] ?? '';
  if (!/^[\p{L}][\p{L}'.-]{0,30}$/u.test(first)) return undefined;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

/**
 * Builds the context quick messages are rendered with for one chat — the
 * customer's first name, their tribe (if the number is a tribe owner or
 * member) and their latest order — and sends them. See quick-messages.ts.
 */
@Injectable()
export class QuickMessagesService {
  constructor(
    @InjectModel(WhatsappConversation.name)
    private readonly conversationModel: Model<WhatsappConversation>,
    @InjectModel(TribeMember.name)
    private readonly memberModel: Model<TribeMember>,
    @InjectModel(Tribe.name) private readonly tribeModel: Model<Tribe>,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly whatsapp: WhatsappService,
  ) {}

  private get siteUrl(): string {
    const raw = (process.env.FRONTEND_URL || '').split(',')[0].trim();
    return (
      /^https:\/\//.test(raw) ? raw : 'https://tribemerchandise.com'
    ).replace(/\/+$/, '');
  }

  /** Everything the picker needs for this chat. `tribeId` picks among several tribes. */
  async list(contact: string, tribeId?: string) {
    const { ctx, tribes, chosenTribeId, orderSummary } = await this.context(
      contact,
      tribeId,
    );
    return {
      context: {
        firstName: ctx.firstName ?? null,
        tribes,
        tribeId: chosenTribeId,
        order: orderSummary,
        siteUrl: ctx.siteUrl,
      },
      categories: QUICK_CATEGORIES,
      messages: QUICK_MESSAGES.map((m) => {
        const reason = unavailableReason(m, ctx);
        return {
          id: m.id,
          category: m.category,
          title: m.title,
          description: m.description,
          available: !reason,
          reason,
          preview: reason ? null : m.render(ctx),
        };
      }),
    };
  }

  async send(contact: string, id: string, tribeId?: string) {
    const message = QUICK_MESSAGES.find((m) => m.id === id);
    if (!message) throw new NotFoundException('Unknown quick message');
    const { ctx } = await this.context(contact, tribeId);
    const reason = unavailableReason(message, ctx);
    if (reason) throw new BadRequestException(reason);
    const payload = message.render(ctx);
    const problems = limitProblems(payload);
    if (problems.length) {
      throw new BadRequestException(
        `This message doesn't fit WhatsApp's limits: ${problems.join(', ')}`,
      );
    }
    return this.whatsapp.sendQuick(contact, id, payload);
  }

  private async context(contact: string, tribeId?: string) {
    const conversation: any = await this.conversationModel
      .findOne({ contact })
      .lean()
      .exec();
    if (!conversation)
      throw new NotFoundException('No WhatsApp conversation with that number');
    const key = phoneKey(contact);
    const phones = [key, `91${key}`, `+91${key}`, `+91 ${key}`];

    // Tribes this number belongs to — as the owner or as a member.
    const [allTribes, memberships] = await Promise.all([
      this.tribeModel
        .find()
        .select('brand name username userId')
        .populate({ path: 'userId', select: 'name phoneNumber' })
        .lean()
        .exec(),
      this.memberModel
        .find({ phone: { $in: phones } } as any)
        .select('coachId name')
        .lean()
        .exec(),
    ]);
    const memberOf = new Map(
      (memberships as any[]).map((m) => [String(m.coachId), m]),
    );
    const linked = (allTribes as any[]).filter(
      (t) =>
        memberOf.has(String(t._id)) ||
        (key.length === 10 && phoneKey(t.userId?.phoneNumber) === key),
    );
    const tribes = linked.map((t) => ({
      id: String(t._id),
      brand: t.brand || t.name || t.userId?.name || 'Tribe',
      username: t.username || null,
    }));
    const chosen =
      (tribeId &&
        isValidObjectId(tribeId) &&
        tribes.find((t) => t.id === tribeId)) ||
      (tribes.length === 1 ? tribes[0] : undefined);

    // Latest order to this number (within the chosen tribe, when there is one).
    const order: any = await this.orderModel
      .findOne({
        'shippingAddress.phone': { $in: phones },
        isDeleted: { $ne: true },
        approvalStatus: { $ne: 'REJECTED' },
        ...(chosen ? { coachId: chosen.id } : {}),
      } as any)
      .sort({ createdAt: -1 })
      .populate('campaignId', 'name')
      .populate('coachId', 'brand name')
      .lean()
      .exec();

    const member = chosen ? memberOf.get(chosen.id) : (memberships as any[])[0];
    const ctx: QuickContext = {
      firstName:
        firstNameOf(member?.name) ||
        firstNameOf(order?.shippingAddress?.fullName) ||
        firstNameOf(conversation.profileName),
      siteUrl: this.siteUrl,
      ...(chosen
        ? {
            tribe: {
              id: chosen.id,
              brand: chosen.brand,
              ...(chosen.username
                ? {
                    storeUrl: `${this.siteUrl}/s/${encodeURIComponent(chosen.username)}`,
                  }
                : {}),
            },
          }
        : {}),
      ...(order
        ? {
            order: {
              shortId: String(order._id).slice(-8).toUpperCase(),
              status: order.status,
              statusText:
                order.approvalStatus === 'PENDING'
                  ? `Awaiting confirmation from ${order.coachId?.brand || 'the team'}`
                  : STATUS_TEXT[order.status] || order.status,
              trackingNumber: order.trackingNumber || undefined,
              campaignName: order.campaignId?.name || undefined,
              brand: order.coachId?.brand || order.coachId?.name || undefined,
            },
          }
        : {}),
    };
    const orderSummary = ctx.order
      ? {
          shortId: ctx.order.shortId,
          statusText: ctx.order.statusText,
          trackingNumber: ctx.order.trackingNumber ?? null,
        }
      : null;
    return { ctx, tribes, chosenTribeId: chosen?.id ?? null, orderSummary };
  }
}
