import nodemailer from 'nodemailer';

export type SendCode = (email: string, code: string) => Promise<void>;
export interface CodeMessage { subject: string; text: string; html: string }

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** One email for every code: verification, sign-in and recovery share the wording. */
export function codeMessage(code: string): CodeMessage {
  if (!/^\d{6}$/.test(code)) throw new Error('Codes are six digits');
  const subject = `${code} is your Roots code`;
  const text = [
    `Your Roots code is ${code}.`,
    '',
    'It expires in 10 minutes and can be used once.',
    'If you did not ask for it, ignore this email. Roots will never ask you to share it.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f7f3e9;font-family:Arial,Helvetica,sans-serif;color:#203749">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fffdf8;border:1px solid #e3dccb;border-radius:16px;padding:32px">
<tr><td style="font-size:22px;font-weight:700;letter-spacing:-0.5px">roots</td></tr>
<tr><td style="padding-top:24px;font-size:16px;line-height:24px">Use this code to continue:</td></tr>
<tr><td style="padding:16px 0;font-size:34px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace">${escape(code)}</td></tr>
<tr><td style="font-size:14px;line-height:22px;color:#4d6170">It expires in 10 minutes and can be used once. If you did not ask for it, ignore this email. Roots will never ask you to share it.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/**
 * Email delivery for codes. Resend (HTTPS API, RESEND_API_KEY) is preferred because it
 * needs no outbound SMTP port; SMTP_* remains supported. EMAIL_FROM (or SMTP_FROM) is
 * the sender, which must be on a domain verified with the provider.
 */
export function mailer(request: typeof fetch = fetch): SendCode | undefined {
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM;
  if (!from) return undefined;
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    return async (email, code) => {
      const message = codeMessage(code);
      const response = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [email], subject: message.subject, text: message.text, html: message.html }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`email_provider_status_${response.status}`);
    };
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT) return undefined;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
  });
  return async (email, code) => {
    const message = codeMessage(code);
    await transport.sendMail({ from, to: email, ...message });
  };
}
