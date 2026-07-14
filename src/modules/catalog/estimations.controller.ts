import { Body, Controller, Post } from '@nestjs/common';
import { QuoteRequestsService } from './quote-requests.service';
import { GuestEstimationDto } from './dto/quote-request.dto';

// Public "Get Estimation" endpoint — a logged-out visitor submits their kit
// plus name + mobile and receives the priced estimate. Recorded as a GUEST
// request for the admin to follow up.
@Controller('estimations')
export class EstimationsController {
  constructor(private readonly requests: QuoteRequestsService) {}

  @Post()
  create(@Body() dto: GuestEstimationDto) {
    return this.requests.createGuestEstimation(dto);
  }
}
