/**
 * Sends one test sign-in code email with the configured provider, to check email setup.
 *   node --import tsx scripts/test-email.ts you@example.com
 * Uses RESEND_API_KEY (or SMTP_*) and EMAIL_FROM from the environment. Prints no secrets.
 */
import 'dotenv/config';
import { mailer } from '../services/api/src/email.js';

const to = process.argv[2];
if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error('Usage: node --import tsx scripts/test-email.ts you@example.com');
  process.exit(2);
}
const from = process.env.EMAIL_FROM || process.env.SMTP_FROM;
const provider = process.env.RESEND_API_KEY ? 'Resend' : process.env.SMTP_HOST ? 'SMTP' : null;
if (!from || !provider) {
  console.error(`Email is not configured: ${!from ? 'EMAIL_FROM is missing. ' : ''}${!provider ? 'Set RESEND_API_KEY (or SMTP_HOST and SMTP_PORT).' : ''}`);
  process.exit(1);
}
const send = mailer();
if (!send) { console.error('Email is not configured.'); process.exit(1); }
try {
  await send(to, '123456');
  console.log(`Sent a test code email via ${provider} from ${from}. Check the inbox (and spam) for code 123456.`);
} catch (error) {
  console.error(`Sending failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error('With Resend, check the API key and that the EMAIL_FROM domain is verified in Resend → Domains.');
  process.exit(1);
}
