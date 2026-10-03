import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderStatus } from '../../../schemas/order.schema';
import { BarcodeType } from '../../../schemas/barcode.schema';

// PATCH /orders/:id/status. Which moves are allowed is decided in
// OrdersService.updateStatus (ALLOWED_TRANSITIONS).
export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;

  // An explicit tracking number (e.g. entered at dispatch) overrides the barcode.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  trackingNumber?: string;

  // Chosen at pack time when the order has no delivery type of its own.
  @IsOptional()
  @IsEnum(BarcodeType)
  deliveryType?: BarcodeType;
}
