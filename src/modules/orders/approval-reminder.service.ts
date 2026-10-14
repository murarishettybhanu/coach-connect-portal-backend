import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ApprovalStatus, Order, OrderType } from '../../schemas/order.schema';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JobRun, claimJobWindow } from './job-run.schema';
import { titleCaseName } from '../../common/utils/name.util';

/** Meta template `pending_order_approval_reminder` ({{1}} owner, {{2}} count, {{3}} product-wise list). */
const DEFAULT_TEMPLATE_ID = '1520220833273015';
const TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Every 3rd day, counted continuously from this IST date (so month ends don't bunch runs). */
export const REMINDER_ANCHOR = '2026-10-15';
export const REMINDER_EVERY_DAYS = 3;
/** WhatsApp rejects long parameters; keep the product list well inside the body limit. */
const MAX_LIST_CHARS = 600;

export type TribeReminder = {
  tribeId: string;
  brand: string;
  ownerName: string;
  phone?: string;
  pending: number;
  /** Product (campaign / kit) → pending orders, most first. */
  lines: { product: string; count: number }[];
};

/** IST calendar day number (days since 1970-01-01 IST) of an instant. */
export const istDay = (d: Date) =>
  Math.floor((d.getTime() + IST_OFFSET_MS) / DAY_MS);

/** Whether `now` falls on a reminder day (every 3rd IST day from the anchor). */
export function isReminderDay(
  now: Date,
  anchor = REMINDER_ANCHOR,
  every = REMINDER_EVERY_DAYS,
): boolean {
  const anchorDay = istDay(new Date(`${anchor}T00:00:00+05:30`));
  const diff = istDay(now) - anchorDay;
  return ((diff % every) + every) % every === 0;
}

/** "Platinum Kit Telugu: 17 orders, Platinum Kit Tamil: 1 order" — one line, capped. */
export function productList(
  lines: { product: string; count: number }[],
  max = MAX_LIST_CHARS,
): string {
  // Template parameters can't carry newlines, tabs or 4+ spaces.
  const clean = (s: string) =>
    s
      .replace(/[\n\t]+/g, ' ')
      .replace(/ {4,}/g, '   ')
      .trim();
  const parts = lines.map(
    (l) => `${clean(l.product)}: ${l.count} order${l.count === 1 ? '' : 's'}`,
  );
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out}, ${parts[i]}` : parts[i];
    const left = parts.length - i - 1;
    // Leave room for ", and N more" while more remain.
    if (next.length > max - (left ? 20 : 0)) {
      if (!out)
        return `${parts[i].slice(0, max - 21)}…${left ? `, and ${left} more` : ''}`;
      return `${out}, and ${parts.length - i} more`;
    }
    out = next;
  }
  return out;
}

/**
 * Reminds each tribe owner, every 3rd day at 8 AM IST, about welcome-kit claims
 * still waiting for their approval — count plus a per-product breakdown, with
 * the template's button opening the owner portal. Tribes with nothing pending
 * get nothing.
 *
 * Runs daily at 8 AM and only acts on reminder days (`isReminderDay`), so the
 * spacing stays exactly 3 days across month ends. Once per day via JobRun.
 *
 * Gating is the same switch as the nightly digest and weekly report:
 * `WHATSAPP_DIGEST_TEST_NUMBER` routes everything to one number,
 * `WHATSAPP_DIGEST_ENABLED=true` sends to owners, neither set logs only.
 * Template override: `WHATSAPP_APPROVAL_REMINDER_TEMPLATE_ID`.
 */
@Injectable()
export class ApprovalReminderService {
  private readonly logger = new Logger(ApprovalReminderService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly whatsapp: WhatsappService,
    @InjectModel(JobRun.name)
    private readonly jobRunModel?: Model<JobRun>,
  ) {}

  @Cron('0 8 * * *', { name: 'approval-reminder', timeZone: TIMEZONE })
  async runScheduled(): Promise<void> {
    const now = new Date();
    if (!isReminderDay(now)) return;
    const start = new Date(istDay(now) * DAY_MS - IST_OFFSET_MS);
    const end = new Date(start.getTime() + DAY_MS);
    if (
      !(await claimJobWindow(this.jobRunModel, 'approval-reminder', start, end))
    ) {
      this.logger.warn(
        `approval-reminder for ${start.toISOString()} already ran — skipping`,
      );
      return;
    }
    await this.run();
  }

  async run(): Promise<TribeReminder[]> {
    const reminders = await this.buildReminders();
    const testNumber = process.env.WHATSAPP_DIGEST_TEST_NUMBER?.trim();
    const enabled = process.env.WHATSAPP_DIGEST_ENABLED === 'true';
    const templateId =
      process.env.WHATSAPP_APPROVAL_REMINDER_TEMPLATE_ID?.trim() ||
      DEFAULT_TEMPLATE_ID;

    this.logger.log(
      `Approval reminder: ${reminders.length} tribe(s) with pending approvals` +
        (testNumber
          ? ` — routing all to test number ${this.mask(testNumber)}`
          : enabled
            ? ' — sending to tribe owners'
            : ' — dry run, nothing will be sent'),
    );

    for (const r of reminders) {
      this.logger.log(
        `  ${r.brand}: ${r.pending} pending — ${productList(r.lines)}`,
      );
      const to = testNumber || r.phone;
      if (!testNumber && !enabled) continue;
      if (!to) {
        this.logger.warn(
          `  skipped ${r.brand}: the owner has no phone number on record`,
        );
        continue;
      }
      try {
        // Numbered template: values are sent in this order ({{1}}, {{2}}, {{3}}).
        await this.whatsapp.sendTemplateByIdTo(
          to,
          templateId,
          this.templateValues(r),
        );
      } catch (err) {
        // One tribe's failure must not stop the rest of the run.
        this.logger.error(
          `  failed to send the approval reminder for ${r.brand}: ${(err as Error).message}`,
        );
      }
    }
    return reminders;
  }

  templateValues(r: TribeReminder): Record<string, string> {
    return {
      owner: titleCaseName(r.ownerName) || r.brand,
      count: String(r.pending),
      products: productList(r.lines),
    };
  }

  /** Pending welcome-kit claims per tribe, grouped by campaign (kit). */
  async buildReminders(): Promise<TribeReminder[]> {
    const orders: any[] = await this.orderModel
      .find({
        type: OrderType.WELCOME_KIT,
        approvalStatus: ApprovalStatus.PENDING,
        isDeleted: { $ne: true },
      } as any)
      .select('coachId campaignId')
      .populate({
        path: 'coachId',
        select: 'name brand username userId isActive',
        populate: { path: 'userId', select: 'name phoneNumber' },
      })
      .populate('campaignId', 'name')
      .lean()
      .exec();

    const byTribe = new Map<
      string,
      TribeReminder & { counts: Map<string, number> }
    >();
    for (const o of orders) {
      const tribe = o.coachId;
      if (!tribe?._id || tribe.isActive === false) continue;
      const key = String(tribe._id);
      let entry = byTribe.get(key);
      if (!entry) {
        const owner = tribe.userId || {};
        entry = {
          tribeId: key,
          brand: tribe.brand || tribe.name || tribe.username || 'your tribe',
          ownerName: owner.name || tribe.name || '',
          phone: owner.phoneNumber ? String(owner.phoneNumber) : undefined,
          pending: 0,
          lines: [],
          counts: new Map(),
        };
        byTribe.set(key, entry);
      }
      entry.pending++;
      const product = o.campaignId?.name || 'Other';
      entry.counts.set(product, (entry.counts.get(product) ?? 0) + 1);
    }

    return [...byTribe.values()]
      .map(({ counts, ...r }) => ({
        ...r,
        lines: [...counts.entries()]
          .map(([product, count]) => ({ product, count }))
          .sort(
            (a, b) => b.count - a.count || a.product.localeCompare(b.product),
          ),
      }))
      .sort((a, b) => b.pending - a.pending);
  }

  private mask(phone: string): string {
    const d = phone.replace(/\D/g, '');
    return d.length > 4 ? `${'•'.repeat(d.length - 4)}${d.slice(-4)}` : '••••';
  }
}
