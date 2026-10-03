import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderStatus } from '../../schemas/order.schema';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { JobRun, claimJobWindow } from './job-run.schema';
import { titleCaseName } from '../../common/utils/name.util';

/** Meta template `weekly_dispatch_report`. */
const DEFAULT_TEMPLATE_ID = '1638054397686424';
const TIMEZONE = 'Asia/Kolkata';
/** Friday 6pm IST closes the week. */
const CUTOFF_HOUR = 18;
const FRIDAY = 5;

export interface WeeklyLine {
  product: string;
  delivered: number;
  returned: number;
}

export interface TribeWeeklyReport {
  tribeId: string;
  brand: string;
  ownerName: string;
  phone?: string;
  totalDelivered: number;
  totalReturned: number;
  lines: WeeklyLine[];
}

/** The slice of a populated order this job reads. */
interface PopulatedOrder {
  coachId?: {
    _id?: Types.ObjectId | string;
    name?: string;
    brand?: string;
    username?: string;
    userId?: { name?: string; phoneNumber?: string | number } | null;
  } | null;
  items?: Array<{
    selected?: boolean;
    productId?: { name?: string } | null;
  }>;
  statusHistory?: Array<{ status?: string; at?: Date }>;
}

/**
 * Weekly fulfilment report to each tribe owner, Fridays at 6pm IST, covering
 * the seven days since the previous Friday 6pm.
 *
 * Note this counts something different from the nightly digest: that one
 * reports **dispatches**, this one reports **deliveries and returns**, because
 * that is what the `weekly_dispatch_report` template asks for. An order
 * delivered and then returned inside the same week legitimately appears in
 * both columns.
 *
 * Deliberately kept separate from `DispatchDigestService` rather than sharing
 * its aggregation: that job runs nightly in production, and a different
 * question (delivered/returned vs dispatched) is not worth destabilising it
 * for. The small overlap in shape is the price.
 *
 * Gating is shared with the nightly digest, so one switch governs both:
 * `WHATSAPP_DIGEST_TEST_NUMBER` routes everything to one number,
 * `WHATSAPP_DIGEST_ENABLED=true` sends to owners, neither set logs only.
 */
@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly whatsapp: WhatsappService,
    @InjectModel(JobRun.name)
    private readonly jobRunModel?: Model<JobRun>,
  ) {}

  @Cron('0 18 * * 5', { name: 'weekly-report', timeZone: TIMEZONE })
  async runWeekly(): Promise<void> {
    const { start, end } = this.weeklyWindowEndingAt(new Date());
    // Once per window: a second firing (another replica, a restart at the
    // cut-off) finds the window already claimed and sends nothing.
    if (!(await claimJobWindow(this.jobRunModel, 'weekly-report', start, end))) {
      this.logger.warn(
        `weekly-report for the window ending ${end.toISOString()} already ran — skipping`,
      );
      return;
    }
    await this.run(start, end);
  }

  async run(start: Date, end: Date): Promise<TribeWeeklyReport[]> {
    const reports = await this.buildReports(start, end);
    const testNumber = process.env.WHATSAPP_DIGEST_TEST_NUMBER?.trim();
    const enabled = process.env.WHATSAPP_DIGEST_ENABLED === 'true';
    const templateId =
      process.env.WHATSAPP_WEEKLY_TEMPLATE_ID?.trim() || DEFAULT_TEMPLATE_ID;

    this.logger.log(
      `Weekly report ${start.toISOString()} → ${end.toISOString()}: ` +
        `${reports.length} tribe(s) with activity` +
        (testNumber
          ? ` — routing all to test number ${this.mask(testNumber)}`
          : enabled
            ? ' — sending to tribe owners'
            : ' — dry run, nothing will be sent'),
    );

    for (const report of reports) {
      const summary = this.summaryText(report.lines);
      this.logger.log(
        `  ${report.brand}: delivered ${report.totalDelivered}, returned ${report.totalReturned} — ${summary}`,
      );

      const to = testNumber || report.phone;
      if (!testNumber && !enabled) continue;
      if (!to) {
        this.logger.warn(
          `  skipped ${report.brand}: the owner has no phone number on record`,
        );
        continue;
      }

      try {
        await this.whatsapp.sendTemplateByIdTo(
          to,
          templateId,
          this.templateValues(report, start, end),
        );
      } catch (err) {
        // One tribe's failure must not stop the rest of the run.
        this.logger.error(
          `  failed to send the weekly report for ${report.brand}: ${(err as Error).message}`,
        );
      }
    }

    return reports;
  }

  /**
   * The values offered to the template. `sendTemplateByIdTo` sends only the
   * placeholders the template actually declares, so a name the template doesn't
   * use costs nothing.
   *
   * Every name here must stay within Meta's 20-character `parameter_name`
   * limit. The template was originally approved with `weekly_product_summary`
   * (22), which Meta accepted at creation and then refused on every send; it
   * was renamed to `product_summary` in WhatsApp Manager. `sendTemplate`
   * now rejects an over-long name before it reaches Meta.
   */
  templateValues(
    report: TribeWeeklyReport,
    start: Date,
    end: Date,
  ): Record<string, string> {
    const summary = this.summaryText(report.lines);
    return {
      client_name: titleCaseName(report.ownerName) || report.brand,
      client_brand: report.brand,
      week_start_date: this.formatDate(start),
      week_end_date: this.formatDate(end),
      product_summary: summary,
      total_delivered: String(report.totalDelivered),
      total_returned: String(report.totalReturned),
    };
  }

  /**
   * Counts DELIVERED and RETURNED transitions that happened inside the window.
   * Walking `statusHistory` rather than the order's current status matters: an
   * order delivered this week may already have been returned by Friday, and
   * both belong in the report.
   */
  private async buildReports(
    start: Date,
    end: Date,
  ): Promise<TribeWeeklyReport[]> {
    const orders = (await this.orderModel
      .find({
        isDeleted: { $ne: true },
        statusHistory: {
          $elemMatch: {
            status: { $in: [OrderStatus.DELIVERED, OrderStatus.RETURNED] },
            at: { $gte: start, $lt: end },
          },
        },
      })
      .populate('items.productId', 'name')
      .populate({
        path: 'coachId',
        select: 'name brand username userId',
        populate: { path: 'userId', select: 'name phoneNumber' },
      })
      .lean()
      .exec()) as unknown as PopulatedOrder[];

    const byTribe = new Map<
      string,
      TribeWeeklyReport & { counts: Map<string, WeeklyLine> }
    >();

    for (const order of orders) {
      const tribe = order.coachId;
      if (!tribe?._id) continue;
      const tribeId = String(tribe._id);

      let entry = byTribe.get(tribeId);
      if (!entry) {
        const owner = tribe.userId || {};
        entry = {
          tribeId,
          brand: tribe.brand || tribe.name || 'your store',
          ownerName: owner.name || tribe.name || '',
          phone: owner.phoneNumber ? String(owner.phoneNumber) : undefined,
          totalDelivered: 0,
          totalReturned: 0,
          lines: [],
          counts: new Map<string, WeeklyLine>(),
        };
        byTribe.set(tribeId, entry);
      }

      // Unselected items were dropped during approval and never shipped.
      const products = new Set<string>();
      for (const item of order.items || []) {
        if (item.selected === false) continue;
        const name = item.productId?.name;
        if (name) products.add(name);
      }

      for (const step of order.statusHistory || []) {
        const at = step.at ? new Date(step.at) : undefined;
        if (!at || at < start || at >= end) continue;
        const delivered = step.status === OrderStatus.DELIVERED;
        const returned = step.status === OrderStatus.RETURNED;
        if (!delivered && !returned) continue;

        if (delivered) entry.totalDelivered += 1;
        if (returned) entry.totalReturned += 1;

        for (const name of products) {
          const line = entry.counts.get(name) || {
            product: name,
            delivered: 0,
            returned: 0,
          };
          if (delivered) line.delivered += 1;
          if (returned) line.returned += 1;
          entry.counts.set(name, line);
        }
      }
    }

    return [...byTribe.values()]
      .map(({ counts, ...report }) => ({
        ...report,
        lines: [...counts.values()].sort(
          (a, b) =>
            b.delivered - a.delivered || a.product.localeCompare(b.product),
        ),
      }))
      .filter((r) => r.totalDelivered > 0 || r.totalReturned > 0)
      .sort((a, b) => b.totalDelivered - a.totalDelivered);
  }

  /**
   * The seven days ending at the most recent Friday 6pm IST. Run by the cron on
   * Friday at 6pm this is "last Friday 6pm → now"; run at any other time it
   * still closes on a real Friday cut-off rather than a partial week.
   */
  weeklyWindowEndingAt(now: Date): { start: Date; end: Date } {
    // IST is UTC+05:30 with no DST, so 6pm IST is always 12:30 UTC. Doing this
    // on the server's own clock would land half an hour out.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;

    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    const daysSinceFriday = (ist.getUTCDay() - FRIDAY + 7) % 7;
    const cutoffToday = Date.UTC(
      ist.getUTCFullYear(),
      ist.getUTCMonth(),
      ist.getUTCDate(),
      CUTOFF_HOUR,
    );

    let endWall = cutoffToday - daysSinceFriday * DAY_MS;
    // On a Friday before 6pm the week hasn't closed yet — use last Friday's.
    if (daysSinceFriday === 0 && ist.getUTCHours() < CUTOFF_HOUR) {
      endWall -= 7 * DAY_MS;
    }

    const end = new Date(endWall - IST_OFFSET_MS);
    return { start: new Date(end.getTime() - 7 * DAY_MS), end };
  }

  /**
   * Meta rejects a parameter containing newlines, so the per-product lines are
   * joined inline — matching the shape of the template's own example.
   */
  summaryText(lines: WeeklyLine[]): string {
    if (!lines.length) return 'No product breakdown available';
    return lines
      .map(
        (l) =>
          `${l.product} ✅ Delivered: ${l.delivered} | ↩️ Returned: ${l.returned}`,
      )
      .join('  ');
  }

  /** The template's example uses YYYY/MM/DD. */
  formatDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
    return parts.replace(/-/g, '/');
  }

  private mask(phone: string): string {
    return phone.replace(/\d(?=\d{4})/g, 'x');
  }
}
