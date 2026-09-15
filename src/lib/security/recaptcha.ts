import { RECAPTCHA_ACTION } from "@/lib/security/recaptcha-constants";

const RECAPTCHA_MINIMUM_SCORE = 0.5;
const RECAPTCHA_VERIFY_URL =
  "https://www.recaptcha.net/recaptcha/api/siteverify";

type RecaptchaResponse = {
  action?: string;
  hostname?: string;
  score?: number;
  success?: boolean;
};

export type RecaptchaVerification =
  | { ok: true }
  | { ok: false; reason: "failed" | "unavailable" };

export async function verifyAccessRequestCaptcha(
  token: string,
  {
    fetcher = fetch,
    nodeEnv = process.env.NODE_ENV,
    expectedHostname = productionHostname(),
    secretKey = process.env.RECAPTCHA_SECRET_KEY,
    siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY,
  }: {
    fetcher?: typeof fetch;
    nodeEnv?: string;
    expectedHostname?: string;
    secretKey?: string;
    siteKey?: string;
  } = {},
): Promise<RecaptchaVerification> {
  // Keep local development usable without production credentials. If either
  // key is present, however, an incomplete setup must fail rather than give a
  // false sense of protection.
  if (!secretKey || !siteKey) {
    if (nodeEnv !== "production" && !secretKey && !siteKey) {
      return { ok: true };
    }

    return { ok: false, reason: "unavailable" };
  }

  if (nodeEnv === "production" && !expectedHostname) {
    return { ok: false, reason: "unavailable" };
  }

  if (!token || token.length > 4_096) {
    return { ok: false, reason: "failed" };
  }

  try {
    const response = await fetcher(RECAPTCHA_VERIFY_URL, {
      body: new URLSearchParams({
        response: token,
        secret: secretKey,
      }),
      cache: "no-store",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return { ok: false, reason: "unavailable" };
    }

    const result = (await response.json()) as RecaptchaResponse;

    if (
      result.success !== true ||
      result.action !== RECAPTCHA_ACTION ||
      (expectedHostname !== undefined && result.hostname !== expectedHostname) ||
      typeof result.score !== "number" ||
      result.score < RECAPTCHA_MINIMUM_SCORE
    ) {
      return { ok: false, reason: "failed" };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

function productionHostname() {
  const configuredUrl = process.env.PORTAL_SITE_URL;
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const candidate = configuredUrl || (vercelUrl ? `https://${vercelUrl}` : "");

  if (!candidate) return undefined;

  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
