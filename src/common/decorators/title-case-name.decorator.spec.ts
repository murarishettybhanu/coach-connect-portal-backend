import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ShippingAddressDto } from '../../modules/orders/dto/create-order.dto';
import {
  FullAddressDto,
  UpdateAddressDto,
} from '../../modules/orders/dto/attach-address.dto';
import { CreateEnquiryDto } from '../../modules/catalog/dto/enquiry.dto';
import { GuestEstimationDto } from '../../modules/catalog/dto/quote-request.dto';

// Same options as the global ValidationPipe (transform runs before validation).
const transform = <T>(cls: new () => T, plain: object) =>
  plainToInstance(cls, plain);

describe('@TitleCaseName on customer-name fields', () => {
  it.each([
    [ShippingAddressDto, 'fullName'],
    [FullAddressDto, 'fullName'],
    [UpdateAddressDto, 'fullName'],
    [CreateEnquiryDto, 'name'],
    [GuestEstimationDto, 'name'],
  ])('%p.%s is stored title-cased', (cls: any, field: string) => {
    const dto: any = transform(cls, { [field]: '  RAVI   kumar ' });
    expect(dto[field]).toBe('Ravi Kumar');
  });

  it('keeps initials and punctuation', () => {
    const dto = transform(ShippingAddressDto, { fullName: "arun NN d'souza" });
    expect(dto.fullName).toBe("Arun NN D'Souza");
  });

  it('a whitespace-only name still fails validation', async () => {
    const dto = transform(ShippingAddressDto, {
      fullName: '   ',
      phone: '9876543210',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'fullName')).toBe(true);
  });

  it('leaves an omitted optional name alone', () => {
    const dto: any = transform(UpdateAddressDto, {});
    expect(dto.fullName).toBeUndefined();
  });
});
