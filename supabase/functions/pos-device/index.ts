import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const POS_ORIGIN = "https://severus-lian-offline-pos.snowyimage1.chatgpt.site";
const ADMIN_ORIGINS = new Set(["https://severuslian.github.io", "null"]);
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const H = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const S = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function bytesHex(size: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function pairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const raw = Array.from(bytes).map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}
function normalizeCode(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function cors(req: Request) {
  const origin = req.headers.get("Origin") || "null";
  if (origin !== POS_ORIGIN && !ADMIN_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function J(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...(cors(req) || {}), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
async function adminSession(sb: ReturnType<typeof S>, token: unknown) {
  if (typeof token !== "string" || token.length < 40) return null;
  const { data } = await sb.from("sl_access_sessions").select("access_role,expires_at")
    .eq("token_hash", await H(token)).eq("access_role", "admin")
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  return data || null;
}

Deno.serve(async (req) => {
  const c = cors(req);
  if (!c) return new Response("Forbidden origin", { status: 403 });
  if (req.method === "OPTIONS") return new Response("ok", { headers: c });
  if (req.method !== "POST") return J(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const body = await req.json();
    const sb = S();

    if (body.action === "exchange") {
      if ((req.headers.get("Origin") || "") !== POS_ORIGIN) return J(req, { error: "FORBIDDEN_ORIGIN" }, 403);
      const code = normalizeCode(body.code);
      if (code.length !== 10) return J(req, { error: "INVALID_PAIRING_CODE" }, 400);
      const deviceToken = bytesHex(32);
      const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
      const { data: deviceId, error } = await sb.rpc("sl_consume_pos_pairing_code", {
        p_code_hash: await H(code),
        p_device_name: String(body.deviceName || "SEVERUS LIAN iPad POS"),
        p_token_hash: await H(deviceToken),
        p_device_expires_at: expiresAt,
      });
      if (error) throw error;
      if (!deviceId) return J(req, { error: "INVALID_OR_EXPIRED_PAIRING_CODE" }, 403);
      return J(req, { deviceId, deviceToken, scope: "catalog:read", expiresAt });
    }

    if (!await adminSession(sb, body.accessToken)) return J(req, { error: "ADMIN_REQUIRED" }, 403);

    if (body.action === "create-pairing") {
      await sb.from("sl_pos_pairing_codes").delete().or(`expires_at.lt.${new Date().toISOString()},used_at.not.is.null`);
      const code = pairingCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const { error } = await sb.from("sl_pos_pairing_codes").insert({
        code_hash: await H(normalizeCode(code)),
        expires_at: expiresAt,
      });
      if (error) throw error;
      return J(req, { pairingCode: code, expiresAt });
    }

    if (body.action === "list") {
      const { data, error } = await sb.from("sl_pos_devices")
        .select("id,name,scope,expires_at,revoked_at,last_seen_at,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return J(req, { devices: data || [] });
    }

    if (body.action === "revoke") {
      const id = String(body.deviceId || "").trim();
      if (!id) return J(req, { error: "INVALID_DEVICE" }, 400);
      const { error } = await sb.from("sl_pos_devices").update({ revoked_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      return J(req, { ok: true });
    }

    return J(req, { error: "BAD_ACTION" }, 400);
  } catch (error) {
    console.error("pos-device error", error instanceof Error ? error.message : "unknown");
    return J(req, { error: "POS_DEVICE_FAILED" }, 500);
  }
});
