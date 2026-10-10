// Email transport stub. In development it prints the message so you can click the link.
// For production, replace the body with your provider (Postmark, SES, Resend, Mailgun...) and keep the signature.
export async function sendMail(to, subject, body) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('sendMail is not configured: plug in an email provider in src/lib/mailer.js');
  }
  console.log(`\n[mail] to=${to}\n[mail] subject=${subject}\n[mail] ${body}\n`);
}
