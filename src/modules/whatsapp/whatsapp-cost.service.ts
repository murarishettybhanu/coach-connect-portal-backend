import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { WhatsappApiService, type PricingPoint } from './whatsapp-api.service';
import {
  dailySeries,
  lastMonths,
  monthRange,
  templateRows,
  totalsOf,
  type Totals,
} from './whatsapp-costs';

const CACHE_MS = 10 * 60 * 1000;

/**
 * WhatsApp costing from Meta's own analytics (per-message pricing + template
 * analytics). Meta calls these figures approximate; the invoice can differ by
 * taxes / rounding. Cached 10 minutes — the numbers move slowly and every
 * report is several Graph calls.
 */
@Injectable()
export class WhatsappCostService {
  private readonly logger = new Logger(WhatsappCostService.name);
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly api: WhatsappApiService) {}

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private monthPoints(month: string): Promise<PricingPoint[]> {
    return this.cached(`pricing:${month}`, () => {
      const { start, end } = monthRange(month);
      return this.api.pricingAnalytics(start, end);
    });
  }

  private currency(): Promise<string> {
    return this.cached('currency', () =>
      this.api.accountCurrency().catch(() => 'INR'),
    );
  }

  /** This month and last month, for the inbox's Costing button. */
  async summary() {
    const [thisMonth, lastMonth] = lastMonths(2);
    const [cur, prev, currency] = await Promise.all([
      this.monthPoints(thisMonth),
      this.monthPoints(lastMonth),
      this.currency(),
    ]);
    return {
      currency,
      month: { month: thisMonth, ...totalsOf(cur) },
      previous: { month: lastMonth, ...totalsOf(prev) },
    };
  }

  /**
   * The full report: totals for the last `months` months, and for `month`
   * (default: this one) its daily cost by category and per-template stats.
   * A month Meta won't report on comes back with `error` instead of failing
   * the page.
   */
  async report(month?: string, months = 6) {
    const count = Math.min(Math.max(Number(months) || 6, 1), 12);
    const list = lastMonths(count);
    const selected = month || list[0];
    if (!/^\d{4}-\d{2}$/.test(selected))
      throw new BadRequestException('month must look like 2026-10');

    const overview = await Promise.all(
      list.map(
        async (
          m,
        ): Promise<{ month: string; error?: string } & Partial<Totals>> => {
          try {
            return { month: m, ...totalsOf(await this.monthPoints(m)) };
          } catch (err) {
            return { month: m, error: (err as Error).message };
          }
        },
      ),
    );

    const { start, end } = monthRange(selected);
    const [points, currency] = await Promise.all([
      this.monthPoints(selected),
      this.currency(),
    ]);

    let templates: ReturnType<typeof templateRows> = [];
    let templatesError: string | undefined;
    try {
      templates = await this.cached(`templates:${selected}`, async () => {
        const list = await this.api.listTemplates();
        const ids = list.map((t) => t.id);
        const tp = ids.length
          ? await this.api.templateAnalytics(ids, start, end)
          : [];
        return templateRows(tp, list);
      });
    } catch (err) {
      templatesError = (err as Error).message;
      this.logger.warn(
        `Template analytics for ${selected} failed: ${templatesError}`,
      );
    }

    return {
      currency,
      month: selected,
      months: overview,
      totals: totalsOf(points),
      daily: dailySeries(points, start, end),
      templates,
      ...(templatesError ? { templatesError } : {}),
      note: 'Figures from Meta analytics (approximate). Months are UTC calendar months; the invoice can differ by taxes or rounding.',
    };
  }
}
