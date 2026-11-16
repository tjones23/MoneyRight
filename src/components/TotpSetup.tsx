import QRCode from "qrcode";
import { base32Encode } from "@/lib/base32";
import { otpauthUri } from "@/lib/totp";

/**
 * The QR code and key an authenticator app is set up from — at enrollment,
 * and when moving to another app from Settings. Drawn here on the server, so
 * the secret never passes through any third-party service.
 *
 * Apple Passwords and Google Authenticator both read the standard
 * `otpauth://` URI (SHA-1, six digits, 30 seconds), so one QR code serves
 * both. On a phone there's nothing to scan, so the same URI is also a link:
 * iOS hands it to Passwords, Android to Google Authenticator.
 */
export async function TotpSetup({ secret, account }: { secret: Uint8Array; account: string }) {
  const uri = otpauthUri(secret, account);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" });
  const typed = base32Encode(secret).match(/.{1,4}/g)!.join(" ");

  return (
    <div className="space-y-5">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI, nothing to optimize */}
      <img src={qr} alt="QR code for your authenticator app" width={220} height={220} className="mx-auto rounded-lg bg-white" />
      <a
        href={uri}
        className="block rounded-full border border-line bg-surface px-4 py-2 text-center text-sm font-medium hover:border-muted-dim"
      >
        On this phone? Add it to your authenticator app
      </a>
      <details className="text-sm text-muted">
        <summary className="cursor-pointer">Apple Passwords</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            On iPhone, point the Camera at the code and tap <strong>Add Verification Code</strong> — or, on this
            phone, tap the button above.
          </li>
          <li>
            On a Mac, open the <strong>Passwords</strong> app, choose your MoneyRight entry (or make one), click{" "}
            <strong>Edit → Set Up</strong> next to Verification Code, and scan or paste the key below.
          </li>
          <li>
            Save it to the <em>same entry as your MoneyRight password</em>: then Safari fills in the code for you at
            sign-in.
          </li>
        </ol>
      </details>
      <details className="text-sm text-muted">
        <summary className="cursor-pointer">Google Authenticator</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Tap <strong>+</strong>, then <strong>Scan a QR code</strong> — or, on this phone, tap the button above.
          </li>
          <li>
            Or tap <strong>Enter a setup key</strong>: account name MoneyRight, the key below, type{" "}
            <strong>Time based</strong>.
          </li>
          <li>Turn on Google Account backup in the app, so a new phone keeps the code.</li>
        </ol>
      </details>
      <details className="text-sm text-muted">
        <summary className="cursor-pointer">Can&apos;t scan? Enter this key instead</summary>
        <p className="mt-2 break-all font-mono text-text">{typed}</p>
        <p className="mt-1 text-xs">Time-based, 6 digits, every 30 seconds.</p>
      </details>
    </div>
  );
}
