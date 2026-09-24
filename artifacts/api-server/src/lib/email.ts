import nodemailer, { type Transporter } from "nodemailer";

function getTransport(): Transporter {
  const host = process.env.SMTP_HOST;
  const portStr = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !portStr || !user || !pass) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.",
    );
  }

  const port = Number(portStr);
  // Standard convention: port 465 = implicit TLS, others = STARTTLS.
  const secure = port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

function fromAddress(): string {
  return (
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    "Sign Takeoff IQ <no-reply@signtakeoffiq.com>"
  );
}

function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
    ""
  );
}

export interface InvitationEmailParams {
  toEmail: string;
  inviterName: string;
  inviterEmail: string;
  roleLabel: string;
  token: string;
  expiresAt: Date;
}

export async function sendInvitationEmail(params: InvitationEmailParams): Promise<void> {
  const base = appBaseUrl();
  const acceptUrl = `${base}/accept-invite/${params.token}`;
  const expiresStr = params.expiresAt.toLocaleString();

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b1220;font-family:'Inter','Segoe UI',Arial,sans-serif;color:#e5e7eb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1220;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0f172a;border:1px solid #1f2937;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px;border-bottom:1px solid #1f2937;">
                <div style="color:#f59e0b;font-weight:700;letter-spacing:1.5px;font-size:14px;">SIGN TAKEOFF IQ</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <h1 style="margin:0 0 16px 0;font-size:22px;color:#ffffff;">You've been invited</h1>
                <p style="margin:0 0 16px 0;line-height:1.55;color:#cbd5e1;">
                  <strong>${escapeHtml(params.inviterName)}</strong>
                  (<a href="mailto:${escapeHtml(params.inviterEmail)}" style="color:#60a5fa;">${escapeHtml(params.inviterEmail)}</a>)
                  has invited you to join <strong>Sign Takeoff IQ</strong> as a <strong>${escapeHtml(params.roleLabel)}</strong>.
                </p>
                <p style="margin:0 0 24px 0;line-height:1.55;color:#cbd5e1;">
                  Click the button below to accept and set your password.
                </p>
                <p style="margin:0 0 24px 0;">
                  <a href="${acceptUrl}" style="display:inline-block;background:#f59e0b;color:#0b1220;font-weight:600;padding:12px 22px;border-radius:8px;text-decoration:none;">Accept invitation</a>
                </p>
                <p style="margin:0 0 8px 0;color:#94a3b8;font-size:13px;">Or paste this link into your browser:</p>
                <p style="margin:0 0 24px 0;word-break:break-all;">
                  <a href="${acceptUrl}" style="color:#60a5fa;font-size:13px;">${acceptUrl}</a>
                </p>
                <p style="margin:0;color:#64748b;font-size:12px;">
                  This link is valid until ${escapeHtml(expiresStr)}. If you weren't expecting this invitation, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = `You've been invited to join Sign Takeoff IQ as a ${params.roleLabel}.

${params.inviterName} (${params.inviterEmail}) sent you this invitation.

Accept and set your password:
${acceptUrl}

This link is valid until ${expiresStr}.`;

  try {
    await getTransport().sendMail({
      from: fromAddress(),
      to: params.toEmail,
      subject: `You've been invited to Sign Takeoff IQ`,
      html,
      text,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to send invitation email: ${message}`);
  }
}

export interface PasswordResetEmailParams {
  toEmail: string;
  fullName: string | null;
  token: string;
  expiresAt: Date;
}

export async function sendPasswordResetEmail(params: PasswordResetEmailParams): Promise<void> {
  const base = appBaseUrl();
  const resetUrl = `${base}/reset-password/${params.token}`;
  const expiresStr = params.expiresAt.toLocaleString();
  const name = params.fullName?.trim() || "there";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b1220;font-family:'Inter','Segoe UI',Arial,sans-serif;color:#e5e7eb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1220;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0f172a;border:1px solid #1f2937;border-radius:12px;overflow:hidden;">
          <tr><td style="padding:24px 28px;border-bottom:1px solid #1f2937;">
            <div style="color:#f59e0b;font-weight:700;letter-spacing:1.5px;font-size:14px;">SIGN TAKEOFF IQ</div>
          </td></tr>
          <tr><td style="padding:28px;">
            <h1 style="margin:0 0 16px 0;font-size:22px;color:#ffffff;">Reset your password</h1>
            <p style="margin:0 0 16px 0;line-height:1.55;color:#cbd5e1;">Hi ${escapeHtml(name)}, click the button below to set a new password for your Sign Takeoff IQ account.</p>
            <p style="margin:0 0 24px 0;">
              <a href="${resetUrl}" style="display:inline-block;background:#f59e0b;color:#0b1220;font-weight:600;padding:12px 22px;border-radius:8px;text-decoration:none;">Reset password</a>
            </p>
            <p style="margin:0 0 8px 0;color:#94a3b8;font-size:13px;">Or paste this link into your browser:</p>
            <p style="margin:0 0 24px 0;word-break:break-all;">
              <a href="${resetUrl}" style="color:#60a5fa;font-size:13px;">${resetUrl}</a>
            </p>
            <p style="margin:0;color:#64748b;font-size:12px;">This link is valid until ${escapeHtml(expiresStr)}. If you didn't request a password reset, you can safely ignore this email.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = `Hi ${name},

Click the link below to reset your Sign Takeoff IQ password:
${resetUrl}

This link is valid until ${expiresStr}.

If you didn't request a password reset, you can safely ignore this email.`;

  try {
    await getTransport().sendMail({
      from: fromAddress(),
      to: params.toEmail,
      subject: "Reset your Sign Takeoff IQ password",
      html,
      text,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to send password reset email: ${message}`);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
