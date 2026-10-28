// SMTP delivery via nodemailer. Recipient is fixed by configuration.
import nodemailer from 'nodemailer';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

export function smtpProblem(smtp) {
  if (!smtp.host || !smtp.from || !smtp.to) {
    return 'SMTP is not configured (set SMTP_HOST, MAIL_FROM and MAIL_TO in /etc/browserrenderer-mcp/notify.env and restart browserrenderer-gateway).';
  }
  if (smtp.security === 'none' && !LOCAL.has(smtp.host.toLowerCase())) {
    return 'SMTP_SECURITY=none is only allowed when SMTP_HOST is localhost.';
  }
  if (/[\r\n]/.test(smtp.from + smtp.to)) return 'MAIL_FROM/MAIL_TO contain invalid characters.';
  return null;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function sendMail(smtp, { subject, text, html }) {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls',
    ignoreTLS: smtp.security === 'none',
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
  try {
    await transport.sendMail({ from: smtp.from, to: smtp.to, subject, text, html });
  } finally {
    transport.close();
  }
}
