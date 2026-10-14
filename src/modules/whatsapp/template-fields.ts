/**
 * The dynamic fields of a WhatsApp template, and the send payload built from
 * values for them. Pure (tested); the admin "Send a template" dialog mirrors
 * `templateFields` in the frontend's `lib/whatsapp-template.ts` — keep the field
 * keys identical, they are the contract between the two.
 *
 * Field keys:
 *   header.<n|name>   placeholder in a TEXT header ("Dispatch Update {{date}}")
 *   header.media      link for an IMAGE / VIDEO / DOCUMENT header
 *   body.<n|name>     placeholder in the body ({{1}} or {{customer_name}})
 *   button.<i>        URL suffix of a dynamic URL button, or a COPY_CODE value
 * Authentication templates take one field, body.1 (the code); Meta's OTP button
 * repeats it, so it isn't asked for separately.
 */

export type TemplateFieldKind =
  | 'text'
  | 'image'
  | 'video'
  | 'document'
  | 'url_suffix'
  | 'coupon_code';

export type TemplateField = {
  key: string;
  component: 'HEADER' | 'BODY' | 'BUTTON';
  kind: TemplateFieldKind;
  /** Placeholder name ("1", "customer_name"); "media" for a media header. */
  name: string;
  buttonIndex?: number;
  /** Meta's sample value from the approved template, when it gave one. */
  example?: string;
  maxLength: number;
};

type Component = {
  type?: string;
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: Array<{
    type?: string;
    url?: string;
    text?: string;
    example?: unknown;
  }>;
};

type TemplateLike = { name: string; category?: string; components?: unknown[] };

const PLACEHOLDER = /\{\{\s*([\w]+)\s*\}\}/g;
const MEDIA_FORMATS: Record<string, TemplateFieldKind> = {
  IMAGE: 'image',
  VIDEO: 'video',
  DOCUMENT: 'document',
};
/** Meta's limits: header text parameters are short; body parameters up to 1024. */
const LIMITS = {
  header: 60,
  body: 1024,
  button: 2000,
  coupon: 20,
  media: 2000,
};

const placeholders = (text = '') => [
  ...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1])),
];
const componentsOf = (t: TemplateLike) => (t.components ?? []) as Component[];
const find = (t: TemplateLike, type: string) =>
  componentsOf(t).find((c) => String(c.type).toUpperCase() === type);

/** Meta's sample values, by placeholder, for the body or header. */
function examples(
  c: Component | undefined,
  part: 'body' | 'header',
): Record<string, string> {
  const ex = (c?.example ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  const named = ex[`${part}_text_named_params`] as
    | Array<{ param_name: string; example: string }>
    | undefined;
  for (const p of named ?? []) out[p.param_name] = String(p.example ?? '');
  const positional = ex[`${part}_text`] as unknown;
  // body_text is [[a, b, c]]; header_text is [a].
  const list = Array.isArray(positional)
    ? Array.isArray(positional[0])
      ? positional[0]
      : positional
    : [];
  (list as unknown[]).forEach((v, i) => (out[String(i + 1)] = String(v ?? '')));
  return out;
}

export function templateFields(template: TemplateLike): TemplateField[] {
  const fields: TemplateField[] = [];
  const header = find(template, 'HEADER');
  const body = find(template, 'BODY');
  const buttons = find(template, 'BUTTONS')?.buttons ?? [];

  if (String(template.category).toUpperCase() === 'AUTHENTICATION') {
    // Meta writes the copy; the only value is the code itself.
    return [
      {
        key: 'body.1',
        component: 'BODY',
        kind: 'text',
        name: '1',
        maxLength: 15,
      },
    ];
  }

  if (header) {
    const format = String(header.format ?? 'TEXT').toUpperCase();
    if (MEDIA_FORMATS[format]) {
      fields.push({
        key: 'header.media',
        component: 'HEADER',
        kind: MEDIA_FORMATS[format],
        name: 'media',
        maxLength: LIMITS.media,
      });
    } else {
      const ex = examples(header, 'header');
      for (const name of placeholders(header.text)) {
        fields.push({
          key: `header.${name}`,
          component: 'HEADER',
          kind: 'text',
          name,
          example: ex[name] || undefined,
          maxLength: LIMITS.header,
        });
      }
    }
  }

  const bodyEx = examples(body, 'body');
  for (const name of placeholders(body?.text)) {
    fields.push({
      key: `body.${name}`,
      component: 'BODY',
      kind: 'text',
      name,
      example: bodyEx[name] || undefined,
      maxLength: LIMITS.body,
    });
  }

  buttons.forEach((b, i) => {
    const type = String(b.type).toUpperCase();
    if (type === 'URL' && placeholders(b.url).length) {
      const ex = Array.isArray(b.example) ? String(b.example[0] ?? '') : '';
      const prefix = (b.url ?? '').split('{{')[0];
      fields.push({
        key: `button.${i}`,
        component: 'BUTTON',
        kind: 'url_suffix',
        name: '1',
        buttonIndex: i,
        example: ex.startsWith(prefix)
          ? ex.slice(prefix.length) || undefined
          : undefined,
        maxLength: LIMITS.button,
      });
    } else if (type === 'COPY_CODE') {
      const ex = Array.isArray(b.example)
        ? String(b.example[0] ?? '')
        : typeof b.example === 'string'
          ? b.example
          : '';
      fields.push({
        key: `button.${i}`,
        component: 'BUTTON',
        kind: 'coupon_code',
        name: 'code',
        buttonIndex: i,
        example: ex || undefined,
        maxLength: LIMITS.coupon,
      });
    }
  });
  return fields;
}

/** Whether a header/body uses numbered ({{1}}) placeholders — Meta's wire format differs. */
const positional = (names: string[]) =>
  names.length > 0 && names.every((n) => /^\d+$/.test(n));

export type TemplateValues = Record<string, string>;

/**
 * Meta's `components` for a send, from values keyed like the fields. Throws a
 * readable Error naming what's missing or invalid (the caller turns it into a 400).
 */
export function buildTemplateComponents(
  template: TemplateLike,
  raw: TemplateValues,
): Record<string, unknown>[] {
  const fields = templateFields(template);
  const values: TemplateValues = {};
  const problems: string[] = [];
  for (const f of fields) {
    const v = String(raw[f.key] ?? '').trim();
    if (!v) problems.push(`${labelOf(f)} is required`);
    else if (v.length > f.maxLength)
      problems.push(`${labelOf(f)} must be at most ${f.maxLength} characters`);
    else if (f.key === 'header.media') {
      if (!/^https:\/\/\S+$/i.test(v))
        problems.push(`${labelOf(f)} must be an https:// link`);
    } else if (f.component !== 'BUTTON' && /[\n\t]| {4,}/.test(v)) {
      // WhatsApp rejects text parameters with newlines, tabs or 4+ spaces in a row.
      problems.push(
        `${labelOf(f)} can't contain line breaks, tabs or 4+ spaces`,
      );
    }
    values[f.key] = v;
  }
  if (problems.length) throw new Error(problems.join('; '));

  const components: Record<string, unknown>[] = [];
  const text = (component: 'HEADER' | 'BODY') => {
    const list = fields.filter(
      (f) => f.component === component && f.kind === 'text',
    );
    const numbered = positional(list.map((f) => f.name));
    // Positional values go in placeholder order ({{1}}, {{2}} …).
    const ordered = numbered
      ? [...list].sort((a, b) => Number(a.name) - Number(b.name))
      : list;
    return ordered.map((f) =>
      numbered
        ? { type: 'text', text: values[f.key] }
        : { type: 'text', parameter_name: f.name, text: values[f.key] },
    );
  };

  const media = fields.find((f) => f.key === 'header.media');
  if (media) {
    components.push({
      type: 'header',
      parameters: [
        { type: media.kind, [media.kind]: { link: values[media.key] } },
      ],
    });
  } else {
    const header = text('HEADER');
    if (header.length) components.push({ type: 'header', parameters: header });
  }
  const body = text('BODY');
  if (body.length) components.push({ type: 'body', parameters: body });

  if (String(template.category).toUpperCase() === 'AUTHENTICATION') {
    // The OTP button carries the same code (Meta spells its sub_type 'url').
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: values['body.1'] }],
    });
  }
  for (const f of fields.filter((x) => x.component === 'BUTTON')) {
    components.push(
      f.kind === 'coupon_code'
        ? {
            type: 'button',
            sub_type: 'copy_code',
            index: String(f.buttonIndex),
            parameters: [{ type: 'coupon_code', coupon_code: values[f.key] }],
          }
        : {
            type: 'button',
            sub_type: 'url',
            index: String(f.buttonIndex),
            parameters: [{ type: 'text', text: values[f.key] }],
          },
    );
  }
  return components;
}

/** The body as the customer sees it, for the thread view. */
export function renderTemplateBody(
  template: TemplateLike,
  values: TemplateValues,
): string | null {
  const body = find(template, 'BODY')?.text;
  if (!body) return null;
  return body.replace(
    PLACEHOLDER,
    (whole, name: string) => values[`body.${name}`]?.trim() || whole,
  );
}

export function labelOf(f: TemplateField): string {
  if (f.key === 'header.media') return `Header ${f.kind}`;
  if (f.kind === 'url_suffix')
    return `Button ${Number(f.buttonIndex) + 1} link`;
  if (f.kind === 'coupon_code') return 'Coupon code';
  return `${f.component === 'HEADER' ? 'Header' : 'Body'} {{${f.name}}}`;
}
