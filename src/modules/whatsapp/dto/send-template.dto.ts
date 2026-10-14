import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class SendTemplateDto {
  @IsString()
  @Matches(/^[a-z0-9_]{1,512}$/, { message: 'Invalid template name' })
  name: string;

  @IsString()
  @Matches(/^[a-z]{2,3}(_[A-Z]{2})?$/, { message: 'Invalid language code' })
  language: string;

  // Values for the body's {{1}}, {{2}} … placeholders, in order.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  parameters?: string[];

  // Values keyed by field — `header.<name>`, `header.media`, `body.<name>`,
  // `button.<index>` (template-fields.ts). Preferred over `parameters`: covers
  // named placeholders, header text/media and dynamic buttons. Checked against
  // the template itself in the service.
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;
}
