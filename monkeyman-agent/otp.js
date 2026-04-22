// otp.js
// Direct port of the two n8n Code nodes that generated and verified OTPs.
// Uses the same hash function and 5-minute window so existing OTPs in flight
// during your cutover remain valid.

import 'dotenv/config';

const SECRET = process.env.OTP_SECRET || 'change-me-in-env';
const WINDOW_MS = 5 * 60 * 1000;

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function otpForWindow(email, window) {
  const h = simpleHash(`${email}:${window}:${SECRET}`);
  return String((h % 900000) + 100000);
}

/**
 * Generate an OTP for the given email and forward it to GHL for delivery.
 * In dev (no GHL_OTP_WEBHOOK set), the OTP prints to the console.
 */
export async function sendOtp({ email, firstName = '', lastName = '', phone = '' }) {
  if (!email) return { success: false, message: 'Email is required' };

  const normalized = String(email).toLowerCase().trim();
  const window = Math.floor(Date.now() / WINDOW_MS);
  const otp = otpForWindow(normalized, window);

  if (process.env.GHL_OTP_WEBHOOK) {
    try {
      const res = await fetch(process.env.GHL_OTP_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email: normalized, otp, phone }),
      });
      if (!res.ok) {
        return { success: false, message: `GHL responded ${res.status}` };
      }
    } catch (err) {
      return { success: false, message: `Failed to forward OTP: ${err.message}` };
    }
  } else {
    // Dev mode — never log OTPs in production
    console.log(`[DEV-OTP] ${normalized} -> ${otp}`);
  }

  return { success: true, message: 'OTP sent successfully' };
}

/**
 * Verify a 6-digit code. Allows the current 5-minute window or the previous
 * one to handle clock-edge cases — same as the n8n logic.
 */
export function verifyOtp({ email, otp }) {
  if (!email) return { verified: false, message: 'Email is required' };
  if (otp === undefined || otp === null) return { verified: false, message: 'OTP is required' };

  const userOtp = String(otp).trim();
  if (!/^\d{6}$/.test(userOtp)) {
    return { verified: false, message: 'OTP must be 6 digits' };
  }

  const normalized = String(email).toLowerCase().trim();
  const now = Math.floor(Date.now() / WINDOW_MS);

  for (const w of [now, now - 1]) {
    if (otpForWindow(normalized, w) === userOtp) {
      return { verified: true, message: 'OTP verified successfully' };
    }
  }

  return { verified: false, message: 'Invalid or expired OTP. Please try again.' };
}
