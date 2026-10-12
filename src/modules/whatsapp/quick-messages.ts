/**
 * Quick messages — ready-made replies the admin inbox sends in one click,
 * inside WhatsApp's 24-hour window. Unlike Meta templates they need no
 * approval, so they can use interactive formats: up to 3 reply buttons, a
 * link (CTA URL) button, or a list. A customer's tap comes back to the inbox
 * as their reply (inbound `interactive`, shown as the button's title).
 *
 * Platform messages work for anyone; Tribe messages need the chat's tribe
 * (the number is that tribe's owner or member); Order messages need the
 * customer's latest order. `render` is pure: everything it shows comes from
 * the QuickContext the service builds for the chat.
 */

export type QuickCategory =
  | 'SERVICE'
  | 'ORDERS'
  | 'FEEDBACK'
  | 'EXPLORE'
  | 'TRIBE';

export const QUICK_CATEGORIES: { id: QuickCategory; label: string }[] = [
  { id: 'SERVICE', label: 'Service' },
  { id: 'ORDERS', label: 'Orders' },
  { id: 'FEEDBACK', label: 'Feedback' },
  { id: 'EXPLORE', label: 'Explore' },
  { id: 'TRIBE', label: 'Tribe' },
];

export type QuickContext = {
  /** Customer's first name, when known (chat profile, member or order). */
  firstName?: string;
  /** Site root without a trailing slash, e.g. https://tribemerchandise.com */
  siteUrl: string;
  tribe?: { id: string; brand: string; storeUrl?: string };
  order?: {
    shortId: string;
    status: string;
    statusText: string;
    trackingNumber?: string;
    campaignName?: string;
    brand?: string;
  };
};

export type QuickButton = { id: string; title: string };
export type QuickRow = { id: string; title: string; description?: string };

/** What gets sent — maps 1:1 onto the Cloud API message shapes. */
export type QuickPayload =
  | { kind: 'text'; body: string }
  | {
      kind: 'buttons';
      header?: string;
      body: string;
      footer?: string;
      buttons: QuickButton[];
    }
  | {
      kind: 'cta_url';
      header?: string;
      body: string;
      footer?: string;
      cta: { label: string; url: string };
    }
  | {
      kind: 'list';
      header?: string;
      body: string;
      footer?: string;
      button: string;
      rows: QuickRow[];
    };

export type QuickRequirement = 'tribe' | 'store' | 'order' | 'tracking';

export type QuickMessage = {
  id: string;
  category: QuickCategory;
  title: string;
  description: string;
  requires: QuickRequirement[];
  render: (ctx: QuickContext) => QuickPayload;
};

/** WhatsApp's documented limits for interactive messages. */
export const LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  buttonTitle: 20,
  buttons: 3,
  ctaLabel: 20,
  listButton: 20,
  rowTitle: 24,
  rowDescription: 72,
  rows: 10,
};

export const INDIA_POST_TRACKING_URL =
  'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx';

const FOOTER = 'Tribe Merchandise';
const hi = (ctx: QuickContext) =>
  ctx.firstName ? `Hi ${ctx.firstName}` : 'Hi there';
const trim = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const feedbackButtons = (prefix: string): QuickButton[] => [
  { id: `${prefix}:loved`, title: '😍 Loved it' },
  { id: `${prefix}:okay`, title: '🙂 It was okay' },
  { id: `${prefix}:unhappy`, title: '😕 Not happy' },
];

export const QUICK_MESSAGES: QuickMessage[] = [
  // ── Service ──────────────────────────────────────────────────────────────
  {
    id: 'service.welcome',
    category: 'SERVICE',
    title: 'Welcome — how can we help?',
    description:
      'Greets the customer and offers the three most common topics as buttons.',
    requires: [],
    render: (ctx) => ({
      kind: 'buttons',
      header: 'Tribe Merchandise',
      body: `${hi(ctx)} 👋 Thanks for reaching out to Tribe Merchandise.\n\nHow can we help you today? Tap an option below or just type your question.`,
      footer: FOOTER,
      buttons: [
        { id: 'svc:track', title: '📦 Track my order' },
        { id: 'svc:support', title: '🙋 Talk to support' },
        { id: 'svc:bulk', title: '🛍️ Bulk order' },
      ],
    }),
  },
  {
    id: 'service.looking_into_it',
    category: 'SERVICE',
    title: "We're looking into it",
    description:
      'Acknowledges the issue and sets the expectation of a quick follow-up.',
    requires: [],
    render: (ctx) => ({
      kind: 'text',
      body: `${hi(ctx)}, thanks for letting us know. 🙏\n\nWe're looking into this right now and will update you here shortly. You don't need to send anything else for the moment.`,
    }),
  },
  {
    id: 'service.need_details',
    category: 'SERVICE',
    title: 'Ask for order details',
    description:
      'Asks for the order ID or registered phone so the team can find the order.',
    requires: [],
    render: (ctx) => ({
      kind: 'text',
      body: `${hi(ctx)}, happy to help! To find your order, please share any one of these:\n\n• Order ID (8 characters, from your confirmation)\n• Tracking number (starts with 2 letters, ends in IN)\n• The phone number used when ordering`,
    }),
  },
  {
    id: 'service.resolved_check',
    category: 'SERVICE',
    title: 'Is your issue resolved?',
    description:
      'Closes the loop after a fix — the customer confirms with one tap.',
    requires: [],
    render: (ctx) => ({
      kind: 'buttons',
      body: `${hi(ctx)}, we've taken care of this from our side. ✅\n\nCould you confirm everything looks good now?`,
      footer: FOOTER,
      buttons: [
        { id: 'svc:resolved:yes', title: '✅ Yes, all good' },
        { id: 'svc:resolved:no', title: '❌ Still need help' },
      ],
    }),
  },
  {
    id: 'service.connect_human',
    category: 'SERVICE',
    title: 'Connecting you to the team',
    description: 'Lets the customer know a person is handling the chat.',
    requires: [],
    render: (ctx) => ({
      kind: 'text',
      body: `${hi(ctx)}, you're now chatting with the Tribe Merchandise team. 🙌\n\nGive us a moment to read through your messages — we'll reply right here.`,
    }),
  },

  // ── Orders ───────────────────────────────────────────────────────────────
  {
    id: 'orders.status',
    category: 'ORDERS',
    title: 'Latest order status',
    description:
      "Shares where the customer's latest order is; a tracking button once shipped.",
    requires: ['order'],
    render: (ctx) => {
      const o = ctx.order!;
      const lines = [
        `${hi(ctx)}, here's the latest on your order${o.brand ? ` from *${o.brand}*` : ''}: 📦`,
        '',
        `*Order:* #${o.shortId}${o.campaignName ? ` (${o.campaignName})` : ''}`,
        `*Status:* ${o.statusText}`,
      ];
      if (o.trackingNumber) lines.push(`*Tracking no.:* ${o.trackingNumber}`);
      const body = lines.join('\n');
      return o.trackingNumber
        ? {
            kind: 'cta_url',
            header: 'Order update',
            body: `${body}\n\nTap below and enter the tracking number to follow your parcel.`,
            footer: FOOTER,
            cta: { label: 'Track on India Post', url: INDIA_POST_TRACKING_URL },
          }
        : {
            kind: 'text',
            body: `${body}\n\nWe'll message you the tracking number as soon as it ships.`,
          };
    },
  },
  {
    id: 'orders.confirm_address',
    category: 'ORDERS',
    title: 'Confirm delivery address',
    description: 'Asks the customer to confirm the address before dispatch.',
    requires: ['order'],
    render: (ctx) => ({
      kind: 'buttons',
      header: 'Delivery address',
      body: `${hi(ctx)}, we're getting order #${ctx.order!.shortId} ready to ship. 📮\n\nIs the delivery address you gave us still correct?`,
      footer: FOOTER,
      buttons: [
        { id: 'ord:address:ok', title: '✅ Address is correct' },
        { id: 'ord:address:change', title: '✏️ Update address' },
      ],
    }),
  },
  {
    id: 'orders.delayed',
    category: 'ORDERS',
    title: 'Delivery is delayed',
    description: 'Apologises for a delay and points to live tracking.',
    requires: ['tracking'],
    render: (ctx) => ({
      kind: 'cta_url',
      header: 'Sorry for the delay',
      body: `${hi(ctx)}, your parcel (${ctx.order!.trackingNumber}) is taking a little longer than usual with India Post. We're sorry about that. 🙏\n\nIt's on its way — you can follow every scan using the tracking number above.`,
      footer: FOOTER,
      cta: { label: 'Track on India Post', url: INDIA_POST_TRACKING_URL },
    }),
  },
  {
    id: 'orders.delivered_check',
    category: 'ORDERS',
    title: 'Did you receive it?',
    description: 'Checks the parcel arrived safely after delivery.',
    requires: ['order'],
    render: (ctx) => ({
      kind: 'buttons',
      body: `${hi(ctx)}, India Post shows order #${ctx.order!.shortId} as delivered. 🎉\n\nDid everything reach you safely?`,
      footer: FOOTER,
      buttons: [
        { id: 'ord:received:yes', title: '✅ Received, thanks' },
        { id: 'ord:received:issue', title: '⚠️ There’s a problem' },
        { id: 'ord:received:no', title: '❌ Not received' },
      ],
    }),
  },

  // ── Feedback ─────────────────────────────────────────────────────────────
  {
    id: 'feedback.rating',
    category: 'FEEDBACK',
    title: 'Rate your experience (1–5)',
    description: 'A star-rating list — one tap from the customer.',
    requires: [],
    render: (ctx) => ({
      kind: 'list',
      header: 'How did we do?',
      body: `${hi(ctx)}, we'd love to know how your experience with Tribe Merchandise was. It takes one tap. ⭐`,
      footer: FOOTER,
      button: 'Rate us',
      rows: [
        {
          id: 'fb:rating:5',
          title: '⭐⭐⭐⭐⭐ Excellent',
          description: 'Loved everything',
        },
        {
          id: 'fb:rating:4',
          title: '⭐⭐⭐⭐ Good',
          description: 'Happy, small things to improve',
        },
        { id: 'fb:rating:3', title: '⭐⭐⭐ Okay', description: 'It was fine' },
        {
          id: 'fb:rating:2',
          title: '⭐⭐ Poor',
          description: 'Several things went wrong',
        },
        {
          id: 'fb:rating:1',
          title: '⭐ Very poor',
          description: 'Not what I expected at all',
        },
      ],
    }),
  },
  {
    id: 'feedback.quick',
    category: 'FEEDBACK',
    title: 'Quick feedback (3 buttons)',
    description: 'Loved it / okay / not happy — the lightest way to ask.',
    requires: [],
    render: (ctx) => ({
      kind: 'buttons',
      body: `${hi(ctx)}, quick question — how do you feel about your Tribe Merchandise order? 💬`,
      footer: FOOTER,
      buttons: feedbackButtons('fb:quick'),
    }),
  },
  {
    id: 'feedback.tell_more',
    category: 'FEEDBACK',
    title: 'Tell us more (website)',
    description:
      'Thanks the customer and links to the contact page for detailed feedback.',
    requires: [],
    render: (ctx) => ({
      kind: 'cta_url',
      header: 'Thank you!',
      body: `${hi(ctx)}, thank you for the feedback — it genuinely helps us improve. 🙏\n\nIf you'd like to share more detail (photos, ideas, anything), you can write to us on our website.`,
      footer: FOOTER,
      cta: { label: 'Share feedback', url: `${ctx.siteUrl}/contact` },
    }),
  },

  // ── Explore (website) ────────────────────────────────────────────────────
  {
    id: 'explore.website',
    category: 'EXPLORE',
    title: 'Visit our website',
    description: 'Introduces Tribe Merchandise with a link to the homepage.',
    requires: [],
    render: (ctx) => ({
      kind: 'cta_url',
      header: 'Tribe Merchandise',
      body: `${hi(ctx)}! Tribe Merchandise helps creators and coaches send branded welcome kits and sell merch to their community — we handle design, stock, packing and delivery. ✨`,
      footer: FOOTER,
      cta: { label: 'Visit website', url: ctx.siteUrl },
    }),
  },
  {
    id: 'explore.estimate',
    category: 'EXPLORE',
    title: 'Get an instant estimate',
    description: 'For bulk / custom enquiries — links to the estimate tool.',
    requires: [],
    render: (ctx) => ({
      kind: 'cta_url',
      header: 'Custom & bulk orders',
      body: `${hi(ctx)}, planning merch or kits for your community or team? 🎁\n\nPick products and quantities on our estimate tool and you'll see a price straight away. Our team follows up within a working day.`,
      footer: FOOTER,
      cta: { label: 'Get estimate', url: `${ctx.siteUrl}/estimate` },
    }),
  },
  {
    id: 'explore.catalog',
    category: 'EXPLORE',
    title: 'Browse the product catalog',
    description: 'Links to the catalog of products we can brand.',
    requires: [],
    render: (ctx) => ({
      kind: 'cta_url',
      body: `${hi(ctx)}, here's our full range of products we can brand for you — apparel, bottles, journals, bags and more. 👕📓`,
      footer: FOOTER,
      cta: { label: 'Browse catalog', url: `${ctx.siteUrl}/catalog` },
    }),
  },
  {
    id: 'explore.case_studies',
    category: 'EXPLORE',
    title: 'See our work (case studies)',
    description: 'Social proof — links to case studies.',
    requires: [],
    render: (ctx) => ({
      kind: 'cta_url',
      body: `${hi(ctx)}, curious how other creators run their merch and welcome kits with us? Here are a few stories. 🚀`,
      footer: FOOTER,
      cta: { label: 'View case studies', url: `${ctx.siteUrl}/case-studies` },
    }),
  },

  // ── Tribe ────────────────────────────────────────────────────────────────
  {
    id: 'tribe.visit_store',
    category: 'TRIBE',
    title: 'Visit the tribe store',
    description: "Links to the tribe's own merchandise page.",
    requires: ['tribe', 'store'],
    render: (ctx) => ({
      kind: 'cta_url',
      header: trim(ctx.tribe!.brand, LIMITS.header),
      body: `${hi(ctx)}! 🛍️ Check out the official *${ctx.tribe!.brand}* merchandise store — everything there is made for the ${ctx.tribe!.brand} community.`,
      footer: 'Powered by Tribe Merchandise',
      cta: { label: 'Visit store', url: ctx.tribe!.storeUrl! },
    }),
  },
  {
    id: 'tribe.new_drop',
    category: 'TRIBE',
    title: 'New merch drop',
    description: "Announces new products on the tribe's store.",
    requires: ['tribe', 'store'],
    render: (ctx) => ({
      kind: 'cta_url',
      header: trim(`New from ${ctx.tribe!.brand}`, LIMITS.header),
      body: `${hi(ctx)}, there's something new in the *${ctx.tribe!.brand}* store! ✨\n\nTake a look before it's gone.`,
      footer: 'Powered by Tribe Merchandise',
      cta: { label: 'Shop now', url: ctx.tribe!.storeUrl! },
    }),
  },
  {
    id: 'tribe.kit_feedback',
    category: 'TRIBE',
    title: 'Feedback on the tribe kit',
    description: 'Asks how the customer liked their kit from this tribe.',
    requires: ['tribe'],
    render: (ctx) => ({
      kind: 'buttons',
      header: trim(ctx.tribe!.brand, LIMITS.header),
      body: `${hi(ctx)}, we hope you're enjoying your *${ctx.tribe!.brand}* kit! 🎁\n\nHow do you like it? Your answer goes straight to the ${ctx.tribe!.brand} team.`,
      footer: 'Powered by Tribe Merchandise',
      buttons: feedbackButtons('tribe:kit'),
    }),
  },
  {
    id: 'tribe.welcome',
    category: 'TRIBE',
    title: 'Welcome to the tribe',
    description:
      "Welcomes a member on behalf of the tribe, with the tribe's store.",
    requires: ['tribe', 'store'],
    render: (ctx) => ({
      kind: 'cta_url',
      header: trim(`Welcome to ${ctx.tribe!.brand}`, LIMITS.header),
      body: `${hi(ctx)}, welcome to the *${ctx.tribe!.brand}* community! 🙌\n\nYour welcome kit is handled by Tribe Merchandise — we'll keep you posted on WhatsApp from packing to delivery. Meanwhile, here's the ${ctx.tribe!.brand} store.`,
      footer: 'Powered by Tribe Merchandise',
      cta: { label: 'Visit store', url: ctx.tribe!.storeUrl! },
    }),
  },
];

/** Why a message can't be used for this chat (null = it can). */
export function unavailableReason(
  m: QuickMessage,
  ctx: QuickContext,
): string | null {
  for (const r of m.requires) {
    if (r === 'tribe' && !ctx.tribe)
      return 'This number isn’t linked to a tribe';
    if (r === 'store' && !ctx.tribe?.storeUrl)
      return 'This tribe has no store link';
    if (r === 'order' && !ctx.order) return 'No order found for this number';
    if (r === 'tracking' && !ctx.order?.trackingNumber)
      return 'The latest order has no tracking number yet';
  }
  return null;
}

/** Plain-text version for the inbox thread and the conversation preview. */
export function previewText(p: QuickPayload): string {
  const parts: string[] = [];
  if (p.kind !== 'text' && p.header) parts.push(`*${p.header}*`);
  parts.push(p.body);
  if (p.kind !== 'text' && p.footer) parts.push(`_${p.footer}_`);
  if (p.kind === 'buttons')
    parts.push(p.buttons.map((b) => `[ ${b.title} ]`).join('  '));
  if (p.kind === 'cta_url') parts.push(`[ ${p.cta.label} ↗ ] ${p.cta.url}`);
  if (p.kind === 'list')
    parts.push(
      `[ ☰ ${p.button} ]\n${p.rows.map((r) => `• ${r.title}`).join('\n')}`,
    );
  return parts.join('\n\n');
}

/** The Cloud API `interactive` object (or null for plain text). */
export function toInteractive(p: QuickPayload): Record<string, unknown> | null {
  if (p.kind === 'text') return null;
  const common = {
    ...(p.header ? { header: { type: 'text', text: p.header } } : {}),
    body: { text: p.body },
    ...(p.footer ? { footer: { text: p.footer } } : {}),
  };
  if (p.kind === 'buttons') {
    return {
      type: 'button',
      ...common,
      action: {
        buttons: p.buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    };
  }
  if (p.kind === 'cta_url') {
    return {
      type: 'cta_url',
      ...common,
      action: {
        name: 'cta_url',
        parameters: { display_text: p.cta.label, url: p.cta.url },
      },
    };
  }
  return {
    type: 'list',
    ...common,
    action: {
      button: p.button,
      sections: [
        {
          title: trim(p.header || 'Options', LIMITS.rowTitle),
          rows: p.rows.map((r) => ({
            id: r.id,
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
          })),
        },
      ],
    },
  };
}

/** Problems with a rendered payload against WhatsApp's limits (empty = fine). */
export function limitProblems(p: QuickPayload): string[] {
  const out: string[] = [];
  // UTF-16 length: stricter than code points, so an emoji never tips a title over.
  const len = (s: string) => s.length;
  if (!p.body.trim()) out.push('empty body');
  if (len(p.body) > LIMITS.body)
    out.push(`body ${len(p.body)} > ${LIMITS.body}`);
  if (p.kind === 'text') return out;
  if (p.header && len(p.header) > LIMITS.header)
    out.push(`header > ${LIMITS.header}`);
  if (p.footer && len(p.footer) > LIMITS.footer)
    out.push(`footer > ${LIMITS.footer}`);
  if (p.kind === 'buttons') {
    if (!p.buttons.length || p.buttons.length > LIMITS.buttons)
      out.push('1–3 buttons');
    for (const b of p.buttons)
      if (len(b.title) > LIMITS.buttonTitle)
        out.push(`button "${b.title}" > ${LIMITS.buttonTitle}`);
    if (new Set(p.buttons.map((b) => b.id)).size !== p.buttons.length)
      out.push('duplicate button ids');
  }
  if (p.kind === 'cta_url') {
    if (len(p.cta.label) > LIMITS.ctaLabel)
      out.push(`cta label > ${LIMITS.ctaLabel}`);
    if (!/^https:\/\//.test(p.cta.url)) out.push('cta url must be https');
  }
  if (p.kind === 'list') {
    if (len(p.button) > LIMITS.listButton)
      out.push(`list button > ${LIMITS.listButton}`);
    if (!p.rows.length || p.rows.length > LIMITS.rows) out.push('1–10 rows');
    for (const r of p.rows) {
      if (len(r.title) > LIMITS.rowTitle)
        out.push(`row "${r.title}" > ${LIMITS.rowTitle}`);
      if (r.description && len(r.description) > LIMITS.rowDescription)
        out.push(`row description > ${LIMITS.rowDescription}`);
    }
  }
  return out;
}
