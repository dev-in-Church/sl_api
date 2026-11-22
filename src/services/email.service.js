// Sends email through Resend (already used for the report emails).
// Needs RESEND_API_KEY, and RESEND_FROM_EMAIL on a domain verified in Resend.
// Never throws: the caller gets { sent, reason } and decides what to tell the user.
import { Resend } from "resend";

let client;

export async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY is not set, so the email was skipped.");
    return { sent: false, reason: "Email is not configured (RESEND_API_KEY is missing)." };
  }
  try {
    client ??= new Resend(process.env.RESEND_API_KEY);
    const { error } = await client.emails.send({
      from:
        process.env.RESEND_FROM_EMAIL ||
        "SuperLeo Payments <payments@dairy.superleo.co.ke>",
      to: [to],
      subject,
      html,
    });
    if (error) {
      console.error("[email] send failed:", error.message);
      return { sent: false, reason: error.message };
    }
    return { sent: true };
  } catch (error) {
    console.error("[email] send failed:", error);
    return { sent: false, reason: error.message || "Email could not be sent." };
  }
}
