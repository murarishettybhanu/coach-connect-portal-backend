import { IsArray, IsIn, IsString, Matches } from 'class-validator';

// Meta's three template categories. AUTHENTICATION has a fixed shape — Meta
// writes and localises the copy itself — so the admin form builds its
// components rather than taking free text.
export const TEMPLATE_CATEGORIES = [
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
] as const;

export class CreateTemplateDto {
  // Meta requires lowercase letters, digits and underscores only.
  @IsString()
  @Matches(/^[a-z0-9_]{1,512}$/, {
    message:
      'Template name must be lowercase letters, numbers and underscores only',
  })
  name: string;

  // BCP-47-ish code as Meta spells it, e.g. "en", "en_US", "hi".
  @IsString()
  @Matches(/^[a-z]{2,3}(_[A-Z]{2})?$/, {
    message: 'Language must look like "en", "en_US" or "hi"',
  })
  language: string;

  @IsIn(TEMPLATE_CATEGORIES)
  category: string;

  // Passed through to Meta as-is — the component schema (HEADER/BODY/FOOTER/
  // BUTTONS) is large and Meta validates it far more thoroughly than we could.
  @IsArray()
  components: Record<string, unknown>[];
}
