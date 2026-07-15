import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * SMTP mail sender (nodemailer). Configured via env:
 *   MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, MAIL_SECURE (true/false),
 *   MAIL_FROM (e.g. "Tribe Merchandise <no-reply@tribemerchandise.com>"),
 *   FRONTEND_URL (login link base, defaults to https://tribemerchandise.com)
 * If SMTP isn't configured, sends are skipped and reported as not-sent (the
 * caller falls back to showing the temp password to the admin).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('MAIL_HOST');
    const user = this.config.get<string>('MAIL_USER');
    const pass = this.config.get<string>('MAIL_PASS');
    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(this.config.get('MAIL_PORT') || 587),
        secure: String(this.config.get('MAIL_SECURE')) === 'true',
        auth: { user, pass },
      });
    } else {
      this.logger.warn(
        'MAIL_HOST/MAIL_USER/MAIL_PASS not set — emails will be skipped.',
      );
    }
  }

  isConfigured(): boolean {
    return this.transporter !== null;
  }

  private get from(): string {
    return (
      this.config.get<string>('MAIL_FROM') ||
      'Tribe Merchandise <no-reply@tribemerchandise.com>'
    );
  }

  private get loginUrl(): string {
    const base =
      this.config.get<string>('FRONTEND_URL') || 'https://tribemerchandise.com';
    return `${base.replace(/\/$/, '')}/login`;
  }

  /** Sends a coach their new login credentials. Returns true if actually sent. */
  async sendTribeWelcome(
    email: string,
    name: string,
    password: string,
  ): Promise<boolean> {
    if (!this.transporter) return false;
    const loginUrl = this.loginUrl;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
        <h2 style="margin:0 0 8px">Welcome to Tribe Merchandise, ${escapeHtml(name || 'Tribe')}!</h2>
        <p style="color:#334155">Your Tribe account has been created. Here are your login details:</p>
        <table style="border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:4px 12px 4px 0;color:#64748b">Email</td><td style="font-weight:700">${escapeHtml(email)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#64748b">Temporary password</td><td style="font-family:monospace;font-weight:700">${escapeHtml(password)}</td></tr>
        </table>
        <p style="margin:16px 0">
          <a href="${loginUrl}" style="background:#2a2270;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Log in</a>
        </p>
        <p style="color:#b45309;font-weight:600">⚠ Please change your password after logging in — use the ⋮ menu in the sidebar → “Change password”.</p>
        <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you didn't expect this email, you can ignore it.</p>
      </div>`;
    const text =
      `Welcome to Tribe Merchandise, ${name || 'Tribe'}!\n\n` +
      `Your Tribe account is ready.\n` +
      `Email: ${email}\n` +
      `Temporary password: ${password}\n\n` +
      `Log in: ${loginUrl}\n\n` +
      `IMPORTANT: Please change your password after logging in (sidebar ⋮ menu → Change password).`;

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: email,
        subject: 'Your Tribe Merchandise account',
        text,
        html,
      });
      this.logger.log(`Sent welcome email to ${email}`);
      return true;
    } catch (e: any) {
      this.logger.error(`Failed to send welcome email to ${email}: ${e.message}`);
      return false;
    }
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}
