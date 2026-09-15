// No mail-sending dependency added here — there's no SMTP/API credential
// to send with yet, and CLAUDE.md says ask before adding a dependency.
// This is the one seam to swap when that's decided: replace `send` with a
// real transport (nodemailer + SMTP, or a provider API) behind the same
// signature. Until then, "sending" an email logs it, so the trigger logic
// (who gets notified, when, exactly once) is correct and testable now.

export interface Email {
  to: string;
  subject: string;
  body: string;
}

export type Mailer = (email: Email) => Promise<void>;

export const consoleMailer: Mailer = async (email) => {
  console.log(`[email] to=${email.to} subject="${email.subject}"\n${email.body}`);
};
