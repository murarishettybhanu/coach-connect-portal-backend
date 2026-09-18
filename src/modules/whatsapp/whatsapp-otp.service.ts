import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { WhatsappOtp } from '../../schemas/whatsapp-otp.schema';
import { WhatsappService } from './whatsapp.service';
import {
  WhatsappApiService,
  type WhatsappTemplate,
} from './whatsapp-api.service';

// The authentication template used to deliver codes. Configured by Meta id
// because that's what the template screen shows and copies; the send API needs
// a name, so the id is resolved once and cached.
const DEFAULT_OTP_TEMPLATE_ID = '1521285713364906';

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
// How long a verification stays good for — long enough to fill in an address,
// short enough that a borrowed token is useless later.
const PROOF_TTL = '30m';

export interface OtpRequestResult {
  sent: true;
  /** Seconds until the code expires, for the countdown in the form. */
  expiresIn: number;
}

export interface OtpVerifyResult {
  verified: true;
  /**
   * Signed proof that this number was verified, passed back with the order so
   * the claim can't be submitted for a number nobody confirmed.
   */
  otpToken: string;
}

/**
 * WhatsApp one-time passcodes for the public campaign forms.
 *
 * Everything here faces the open internet, so the defences are layered: codes
 * are hashed, capped at a few guesses, expire quickly, can't be re-sent in a
 * tight loop, and a success returns a short-lived signed token rather than
 * trusting the browser to say "I verified".
 */
@Injectable()
export class WhatsappOtpService {
  private readonly logger = new Logger(WhatsappOtpService.name);
  private cachedTemplate?: WhatsappTemplate;

  constructor(
    @InjectModel(WhatsappOtp.name)
    private readonly otpModel: Model<WhatsappOtp>,
    private readonly whatsapp: WhatsappService,
    private readonly api: WhatsappApiService,
    private readonly jwt: JwtService,
  ) {}

  /** Sends a fresh code, unless one was sent moments ago. */
  async request(rawPhone: string): Promise<OtpRequestResult> {
    const contact = this.whatsapp.normalizeContact(rawPhone);

    // Check the shape *before* spending a message. normalizeContact is
    // deliberately permissive (it serves the admin inbox, which messages
    // customers abroad), but every number reaching this endpoint comes from an
    // Indian claim form, where a mobile is 10 digits starting 6-9. Without
    // this, a typo'd or made-up number still costs a real WhatsApp send.
    if (!/^91[6-9]\d{9}$/.test(contact)) {
      throw new BadRequestException(
        'Enter a valid 10-digit Indian mobile number starting with 6-9',
      );
    }

    if (!this.api.canSend) {
      throw new ServiceUnavailableException(
        'WhatsApp sending is not configured — cannot verify numbers right now',
      );
    }

    const existing = await this.otpModel.findOne({ contact });
    if (existing) {
      const since = Date.now() - existing.lastSentAt.getTime();
      if (since < RESEND_COOLDOWN_MS) {
        const wait = Math.ceil((RESEND_COOLDOWN_MS - since) / 1000);
        throw new BadRequestException(
          `Please wait ${wait} more second${wait === 1 ? '' : 's'} before asking for another code.`,
        );
      }
    }

    const code = String(randomInt(100000, 1000000));
    const template = await this.resolveTemplate();

    // Store before sending: a code that went out but wasn't saved could never
    // be verified, which is worse than one saved but undelivered.
    await this.otpModel.updateOne(
      { contact },
      {
        $set: {
          codeHash: await bcrypt.hash(code, 10),
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
          lastSentAt: new Date(),
          attempts: 0,
        },
        $unset: { verifiedAt: 1 },
        $setOnInsert: { contact },
      },
      { upsert: true },
    );

    await this.whatsapp.sendTemplateTo(contact, {
      name: template.name,
      language: template.language,
      parameters: [code],
    });

    this.logger.log(`Sent a verification code to ${contact}`);
    return { sent: true, expiresIn: Math.floor(CODE_TTL_MS / 1000) };
  }

  /** Checks a code and, on success, issues the proof the order flow wants. */
  async verify(rawPhone: string, code: string): Promise<OtpVerifyResult> {
    const contact = this.whatsapp.normalizeContact(rawPhone);
    const record = await this.otpModel.findOne({ contact });

    // One message for every failure mode below: telling a caller *which* part
    // was wrong would help them enumerate numbers and codes.
    const rejected = () =>
      new BadRequestException(
        'That code is not right, or it has expired. Ask for a new one.',
      );

    if (!record) throw rejected();
    if (record.expiresAt.getTime() < Date.now()) throw rejected();
    if (record.attempts >= MAX_ATTEMPTS) throw rejected();

    const matches = await bcrypt.compare(code, record.codeHash);
    if (!matches) {
      await this.otpModel.updateOne({ contact }, { $inc: { attempts: 1 } });
      throw rejected();
    }

    await this.otpModel.updateOne(
      { contact },
      // Expire the code on use so the same one can't be replayed.
      { $set: { verifiedAt: new Date(), expiresAt: new Date() } },
    );

    this.logger.log(`Verified ${contact}`);
    return {
      verified: true,
      otpToken: this.jwt.sign(
        { sub: contact, purpose: 'whatsapp-otp' },
        { expiresIn: PROOF_TTL },
      ),
    };
  }

  /**
   * Validates a proof token against the phone number on an order. Returns the
   * reason it failed rather than throwing, so callers can phrase their own
   * error.
   */
  checkProof(
    token: string,
    rawPhone: string,
  ): { ok: boolean; reason?: string } {
    let payload: { sub?: string; purpose?: string };
    try {
      payload = this.jwt.verify(token);
    } catch {
      return { ok: false, reason: 'expired' };
    }

    if (payload.purpose !== 'whatsapp-otp')
      return { ok: false, reason: 'wrong-token' };

    let contact: string;
    try {
      contact = this.whatsapp.normalizeContact(rawPhone);
    } catch {
      return { ok: false, reason: 'bad-number' };
    }

    return payload.sub === contact
      ? { ok: true }
      : { ok: false, reason: 'number-mismatch' };
  }

  /** Resolves the configured template id to the name/language the send needs. */
  private async resolveTemplate(): Promise<WhatsappTemplate> {
    if (this.cachedTemplate) return this.cachedTemplate;

    const id = process.env.WHATSAPP_OTP_TEMPLATE_ID || DEFAULT_OTP_TEMPLATE_ID;
    const template = await this.api.getTemplateById(id);

    if (template.status && template.status !== 'APPROVED') {
      this.logger.warn(
        `OTP template "${template.name}" is ${template.status}, not APPROVED — sends will fail`,
      );
    }
    this.cachedTemplate = template;
    return template;
  }
}
