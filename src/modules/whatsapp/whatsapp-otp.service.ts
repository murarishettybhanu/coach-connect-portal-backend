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
import { OTP_PROOF_AUDIENCE } from '../auth/token-claims';

// The authentication template used to deliver codes. Configured by Meta id
// because that's what the template screen shows and copies; the send API needs
// a name, so the id is resolved once and cached.
const DEFAULT_OTP_TEMPLATE_ID = '1521285713364906';

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
// Rolling caps per number. Every send is a real WhatsApp message to someone's
// phone, so these bound what one person can be sent however many IPs ask.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_SENDS_PER_HOUR = 5;
const MAX_SENDS_PER_DAY = 10;
const OTP_PURPOSE = 'whatsapp-otp';
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

    const now = Date.now();
    const existing = await this.otpModel.findOne({ contact });
    if (existing) {
      const since = now - existing.lastSentAt.getTime();
      if (since < RESEND_COOLDOWN_MS) {
        throw this.cooldownError(RESEND_COOLDOWN_MS - since);
      }
    }

    // Rolling caps per number, on top of the per-IP throttle: rotating IPs
    // must not turn one victim's phone into a stream of codes.
    const age = (at: Date) => now - new Date(at).getTime();
    const recent = (existing?.sendLog ?? []).filter((at) => age(at) < DAY_MS);
    const lastHour = recent.filter((at) => age(at) < HOUR_MS).length;
    if (lastHour >= MAX_SENDS_PER_HOUR) {
      throw new BadRequestException(
        'Too many codes requested for this number. Try again in an hour.',
      );
    }
    if (recent.length >= MAX_SENDS_PER_DAY) {
      throw new BadRequestException(
        'Too many codes requested for this number today. Try again tomorrow.',
      );
    }

    const code = String(randomInt(100000, 1000000));
    const template = await this.resolveTemplate();
    const sentAt = new Date(now);

    // Store before sending: a code that went out but wasn't saved could never
    // be verified, which is worse than one saved but undelivered. The write is
    // conditional on the row being as we read it, so two simultaneous requests
    // can't both get past the cooldown — the loser sees no match (or, for a
    // first-ever send, a duplicate key) and is told to wait.
    const update = {
      $set: {
        codeHash: await bcrypt.hash(code, 10),
        expiresAt: new Date(now + CODE_TTL_MS),
        lastSentAt: sentAt,
        attempts: 0,
        sendLog: [...recent, sentAt],
      },
      $unset: { verifiedAt: 1 },
      $setOnInsert: { contact },
    };
    try {
      const res = existing
        ? await this.otpModel.updateOne(
            { contact, lastSentAt: existing.lastSentAt },
            update,
          )
        : await this.otpModel.updateOne({ contact }, update, { upsert: true });
      if (existing && !res.matchedCount) {
        throw this.cooldownError(RESEND_COOLDOWN_MS);
      }
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw this.cooldownError(RESEND_COOLDOWN_MS);
      }
      throw err;
    }

    try {
      await this.whatsapp.sendTemplateTo(
        contact,
        {
          name: template.name,
          language: template.language,
          parameters: [code],
        },
        // Already resolved: skips a second template lookup on every send.
        { template },
      );
    } catch (err) {
      await this.restore(contact, sentAt, existing);
      throw err;
    }

    this.logger.log(`Sent a verification code to ${contact}`);
    return { sent: true, expiresIn: Math.floor(CODE_TTL_MS / 1000) };
  }

  /**
   * Undoes the write for a code that never went out, so a failed send doesn't
   * clobber the code the customer may already have (or start a cooldown for a
   * message they never got). Conditional on our own `lastSentAt`, so it can't
   * undo a later request's code.
   */
  private async restore(
    contact: string,
    sentAt: Date,
    previous: WhatsappOtp | null,
  ): Promise<void> {
    try {
      if (!previous) {
        await this.otpModel.deleteOne({ contact, lastSentAt: sentAt });
        return;
      }
      await this.otpModel.updateOne(
        { contact, lastSentAt: sentAt },
        {
          $set: {
            codeHash: previous.codeHash,
            expiresAt: previous.expiresAt,
            lastSentAt: previous.lastSentAt,
            attempts: previous.attempts,
            sendLog: previous.sendLog ?? [],
            ...(previous.verifiedAt ? { verifiedAt: previous.verifiedAt } : {}),
          },
        },
      );
    } catch (err) {
      this.logger.error(
        `Could not restore the previous code for ${contact}: ${(err as Error).message}`,
      );
    }
  }

  private cooldownError(remainingMs: number): BadRequestException {
    const wait = Math.max(1, Math.ceil(remainingMs / 1000));
    return new BadRequestException(
      `Please wait ${wait} more second${wait === 1 ? '' : 's'} before asking for another code.`,
    );
  }

  /** Checks a code and, on success, issues the proof the order flow wants. */
  async verify(rawPhone: string, code: string): Promise<OtpVerifyResult> {
    const contact = this.whatsapp.normalizeContact(rawPhone);

    // One message for every failure mode below: telling a caller *which* part
    // was wrong would help them enumerate numbers and codes.
    const rejected = () =>
      new BadRequestException(
        'That code is not right, or it has expired. Ask for a new one.',
      );

    // Spend an attempt *before* comparing, atomically: a read-then-increment
    // would let a burst of parallel guesses all see "attempts: 0" and get far
    // more than MAX_ATTEMPTS tries between them.
    const record = await this.otpModel.findOneAndUpdate(
      {
        contact,
        attempts: { $lt: MAX_ATTEMPTS },
        expiresAt: { $gt: new Date() },
      },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (!record) throw rejected();

    const matches = await bcrypt.compare(code, record.codeHash);
    if (!matches) throw rejected();

    // Consume the code. Conditional on it being this exact, still-unused code,
    // so two simultaneous correct submissions get one proof between them.
    const consumed = await this.otpModel.updateOne(
      {
        contact,
        codeHash: record.codeHash,
        verifiedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      },
      // Expire the code on use so the same one can't be replayed.
      { $set: { verifiedAt: new Date(), expiresAt: new Date() } },
    );
    if (!consumed.modifiedCount) throw rejected();

    this.logger.log(`Verified ${contact}`);
    return {
      verified: true,
      otpToken: this.jwt.sign(
        { sub: contact, purpose: OTP_PURPOSE },
        // The audience keeps a proof from ever passing as a login token, even
        // though both are signed with the same secret.
        { expiresIn: PROOF_TTL, audience: OTP_PROOF_AUDIENCE },
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
    let payload: { sub?: string; purpose?: string; aud?: string | string[] };
    try {
      payload = this.jwt.verify(token);
    } catch {
      return { ok: false, reason: 'expired' };
    }

    // Both claims, so a login token (no audience) can never stand in for a
    // proof and vice versa.
    const audiences = [payload.aud ?? []].flat();
    if (
      payload.purpose !== OTP_PURPOSE ||
      !audiences.includes(OTP_PROOF_AUDIENCE)
    )
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
