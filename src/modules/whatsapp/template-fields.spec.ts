import {
  buildTemplateComponents,
  renderTemplateBody,
  templateFields,
} from './template-fields';

// Shapes as Meta returns our approved templates.
const named = {
  name: 'order_dispach_with_track_button',
  category: 'UTILITY',
  components: [
    {
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: ['https://x/y.jpg'] },
    },
    {
      type: 'BODY',
      text: 'Hello *{{customer_name}}* — your *{{kit_name}}* from {{client_brand}}. {{customer_name}}!',
      example: {
        body_text_named_params: [
          { param_name: 'customer_name', example: 'Bhanuteja' },
          { param_name: 'kit_name', example: 'Diamond Kit' },
          { param_name: 'client_brand', example: 'CBH' },
        ],
      },
    },
    {
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          text: 'Track',
          url: 'https://www.indiapost.gov.in/#trackandtrace',
        },
      ],
    },
  ],
};
const positional = {
  name: 'pending_order_approval_reminder',
  category: 'UTILITY',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Orders Awaiting Your Approval' },
    {
      type: 'BODY',
      text: 'Hello *{{1}}*! {{2}} orders: {{3}}',
      example: { body_text: [['Sumithra', '5', 'Diamond Kit: 2 orders']] },
    },
    {
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          text: 'Open',
          url: 'https://tribemerchandise.com/orders/{{1}}',
          example: ['https://tribemerchandise.com/orders/abc123'],
        },
      ],
    },
  ],
};
const headerText = {
  name: 'order_dispach_update_for_tribe_owner',
  category: 'UTILITY',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Dispatch Update {{date}}' },
    { type: 'BODY', text: 'Hello {{client_name}}' },
  ],
};
const auth = {
  name: 'mobile_whatsapp_number_validation',
  category: 'AUTHENTICATION',
  components: [
    { type: 'BODY', text: '*{{1}}* is your verification code.' },
    {
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          url: 'https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=otp{{1}}',
        },
      ],
    },
  ],
};

describe('templateFields', () => {
  it('named body (deduped), media header, static button → no button field', () => {
    expect(
      templateFields(named).map((f) => [f.key, f.kind, f.example]),
    ).toEqual([
      ['header.media', 'image', undefined],
      ['body.customer_name', 'text', 'Bhanuteja'],
      ['body.kit_name', 'text', 'Diamond Kit'],
      ['body.client_brand', 'text', 'CBH'],
    ]);
  });

  it('positional body with examples and a dynamic URL button suffix', () => {
    expect(templateFields(positional).map((f) => [f.key, f.example])).toEqual([
      ['body.1', 'Sumithra'],
      ['body.2', '5'],
      ['body.3', 'Diamond Kit: 2 orders'],
      ['button.0', 'abc123'],
    ]);
  });

  it('a TEXT header placeholder is its own field', () => {
    expect(templateFields(headerText).map((f) => f.key)).toEqual([
      'header.date',
      'body.client_name',
    ]);
  });

  it('authentication: just the code', () => {
    expect(templateFields(auth).map((f) => f.key)).toEqual(['body.1']);
  });
});

describe('buildTemplateComponents', () => {
  it('named: parameter_name per value, media header link', () => {
    const c = buildTemplateComponents(named, {
      'header.media': 'https://cdn.example.com/kit.jpg',
      'body.customer_name': ' Asha ',
      'body.kit_name': 'Diamond Kit',
      'body.client_brand': 'CBH',
      'body.extra': 'ignored',
    });
    expect(c).toEqual([
      {
        type: 'header',
        parameters: [
          { type: 'image', image: { link: 'https://cdn.example.com/kit.jpg' } },
        ],
      },
      {
        type: 'body',
        parameters: [
          { type: 'text', parameter_name: 'customer_name', text: 'Asha' },
          { type: 'text', parameter_name: 'kit_name', text: 'Diamond Kit' },
          { type: 'text', parameter_name: 'client_brand', text: 'CBH' },
        ],
      },
    ]);
  });

  it('positional: values in {{n}} order, plus the URL button suffix', () => {
    const c = buildTemplateComponents(positional, {
      'body.3': 'c',
      'body.1': 'a',
      'body.2': 'b',
      'button.0': 'xyz',
    });
    expect(c).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
          { type: 'text', text: 'c' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'xyz' }],
      },
    ]);
  });

  it('TEXT header placeholder goes in a header component', () => {
    expect(
      buildTemplateComponents(headerText, {
        'header.date': '15 Oct',
        'body.client_name': 'Ravi',
      })[0],
    ).toEqual({
      type: 'header',
      parameters: [{ type: 'text', parameter_name: 'date', text: '15 Oct' }],
    });
  });

  it('authentication repeats the code in the OTP button', () => {
    expect(buildTemplateComponents(auth, { 'body.1': '123456' })).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: '123456' }],
      },
    ]);
  });

  it('names every missing or invalid value', () => {
    expect(() =>
      buildTemplateComponents(named, {
        'header.media': 'http://insecure',
        'body.customer_name': 'a\nb',
        'body.kit_name': 'K',
      }),
    ).toThrow(
      /Header image must be an https:\/\/ link; Body \{\{customer_name\}\} can't contain line breaks.*; Body \{\{client_brand\}\} is required/,
    );
  });
});

describe('renderTemplateBody', () => {
  it('fills the body for the thread view', () => {
    expect(
      renderTemplateBody(positional, {
        'body.1': 'Sumithra',
        'body.2': '5',
        'body.3': 'x',
      }),
    ).toBe('Hello *Sumithra*! 5 orders: x');
  });
});
