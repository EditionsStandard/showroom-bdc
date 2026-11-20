const ALLOWED_DATES = new Set([
  "2027-01-20","2027-01-21","2027-01-22","2027-01-23",
  "2027-01-24","2027-01-25","2027-01-26"
]);

const ALLOWED_TIMES = new Set([
  "09:00","09:30","10:00","10:30","11:00","11:30",
  "12:00","12:30","13:00","13:30","14:00","14:30",
  "15:00","15:30","16:00","16:30","17:00","17:30",
  "18:00","18:30"
]);

const ALLOWED_CATEGORIES = new Set(["Menswear","Womenswear","Jewellery","Accessories","Design / Lifestyle"]);

const AIRTABLE_WEBHOOK = Bun.env.FW27_AIRTABLE_WEBHOOK || "";

// These guards are intentionally per-instance and bounded: this Function runs as one
// replica. For multiple replicas replace the maps with shared, expiring storage.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const emailBuckets = new Map<string, { count: number; resetAt: number }>();
const recentlyAccepted = new Map<string, number>();
const inFlight = new Map<string, Promise<boolean>>();

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function sweepExpired(now: number) {
  if (recentlyAccepted.size > 1000) {
    for (const [key, expires] of recentlyAccepted) if (expires <= now) recentlyAccepted.delete(key);
  }
  if (emailBuckets.size > 1000) {
    for (const [key, bucket] of emailBuckets) if (bucket.resetAt <= now) emailBuckets.delete(key);
  }
}

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const configuredPreview = Bun.env.FW27_CARGO_PREVIEW_ORIGIN || "";
    const exactAllowed = url.protocol === "https:" && (
      host === "editionsstandard.com" ||
      host === "www.editionsstandard.com" ||
      (configuredPreview && origin === configuredPreview)
    );
    if (exactAllowed) return origin;
  } catch {}
  return null;
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  const accepted = allowedOrigin(origin);
  if (accepted) {
    headers.set("Access-Control-Allow-Origin", accepted);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function json(status: number, body: unknown, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin)
  });
}

function clean(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

Bun.serve({
  port: Number(Bun.env.PORT || 3000),

  async fetch(request) {
    const origin = request.headers.get("origin");
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json(200, { ok: true }, origin);
    }

    if (url.pathname !== "/fw27-appointment") {
      return json(404, { ok: false, error: "not_found" }, origin);
    }

    if (request.method === "OPTIONS") {
      if (!allowedOrigin(origin)) {
        return json(403, { ok: false, error: "origin_forbidden" }, origin);
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, origin);
    }

    if (!allowedOrigin(origin)) {
      return json(403, { ok: false, error: "origin_forbidden" }, origin);
    }

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const now = Date.now();
    if (rateBuckets.size > 1000) {
      for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key);
      if (rateBuckets.size > 4000) return json(429, { ok: false, error: "too_many_requests" }, origin);
    }
    const bucket = rateBuckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      rateBuckets.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
      bucket.count += 1;
      if (bucket.count > 10) {
        return json(429, { ok: false, error: "too_many_requests" }, origin);
      }
    }

    let input: Record<string, unknown>;
    const bytes = Number(request.headers.get("content-length") || "0");
    if (bytes > 20_000) return json(413, { ok: false, error: "payload_too_large" }, origin);

    try {
      const raw = await request.text();
      if (raw.length > 20_000) return json(413, { ok: false, error: "payload_too_large" }, origin);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(400, { ok: false, error: "invalid_json" }, origin);
      input = parsed;
    } catch {
      return json(400, { ok: false, error: "invalid_json" }, origin);
    }

    if (clean(input.website, 100)) {
      return json(202, { ok: true }, origin);
    }

    const payload = {
      source: "Cargo — /book-appointment",
      submitted_at: new Date().toISOString(),
      preferred_date: clean(input.preferred_date, 10),
      preferred_time: clean(input.preferred_time, 5),
      alternative_date_time: clean(input.alternative_date_time, 200),
      collections_of_interest: Array.isArray(input.collections_of_interest)
        ? input.collections_of_interest
            .map(value => clean(value, 100))
            .filter(value => ALLOWED_CATEGORIES.has(value))
            .slice(0, 5)
        : [],
      brands_or_collections: clean(input.brands_or_collections, 2000),
      full_name: clean(input.full_name, 200),
      store_or_company: clean(input.store_or_company, 200),
      store_website: (() => {
        const raw = clean(input.store_website, 300);
        if (!raw) return "";
        try {
          const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
          const parsed = new URL(candidate);
          return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
        } catch {
          return "";
        }
      })(),
      store_instagram: clean(input.store_instagram, 300),
      business_email: clean(input.business_email, 320).toLowerCase(),
      phone: clean(input.phone, 100),
      city_and_country: clean(input.city_and_country, 300)
    };

    if (
      !ALLOWED_DATES.has(payload.preferred_date) ||
      !ALLOWED_TIMES.has(payload.preferred_time) ||
      !payload.full_name ||
      !payload.store_or_company ||
      !payload.city_and_country ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.business_email)
    ) {
      return json(422, { ok: false, error: "invalid_fields" }, origin);
    }

    if (!AIRTABLE_WEBHOOK) {
      console.error("FW27_AIRTABLE_WEBHOOK absent");
      return json(503, { ok: false, error: "intake_not_configured" }, origin);
    }

    // Deduplicate successfully forwarded requests, not just browser button taps.
    // submitted_at varies per retry and is therefore deliberately excluded.
    const [emailKey, requestKey] = await Promise.all([
      fingerprint(payload.business_email),
      fingerprint(JSON.stringify({ ...payload, submitted_at: undefined }))
    ]);
    sweepExpired(Date.now());
    if (recentlyAccepted.get(requestKey)! > Date.now()) {
      return json(202, { ok: true, duplicate: true }, origin);
    }
    const pending = inFlight.get(requestKey);
    if (pending) {
      const accepted = await pending;
      return accepted
        ? json(202, { ok: true, duplicate: true }, origin)
        : json(502, { ok: false, error: "airtable_unavailable" }, origin);
    }

    const currentTime = Date.now();
    let emailBucket = emailBuckets.get(emailKey);
    if (!emailBucket || emailBucket.resetAt <= currentTime) {
      emailBucket = { count: 0, resetAt: currentTime + 60 * 60 * 1000 };
      emailBuckets.set(emailKey, emailBucket);
    }
    // Stops deliberate spamming of a single recipient even if the caller
    // spoofs or changes the IP forwarding header.
    if (emailBucket.count >= 6 || emailBuckets.size > 4000 || inFlight.size > 100) {
      return json(429, { ok: false, error: "too_many_requests" }, origin);
    }
    emailBucket.count += 1;

    const sending: Promise<boolean> = (async () => {
      try {
        const upstream = await fetch(AIRTABLE_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000)
        });
        if (!upstream.ok) {
          console.error("Airtable webhook error", upstream.status);
          return false;
        }
        return true;
      } catch (error) {
        console.error("Airtable webhook request failed", error);
        return false;
      }
    })();
    inFlight.set(requestKey, sending);

    const accepted = await sending;
    inFlight.delete(requestKey);
    if (!accepted) {
      emailBucket.count = Math.max(0, emailBucket.count - 1);
      return json(502, { ok: false, error: "airtable_unavailable" }, origin);
    }
    recentlyAccepted.set(requestKey, Date.now() + 30 * 60 * 1000);
    return json(202, { ok: true }, origin);
  }
});
