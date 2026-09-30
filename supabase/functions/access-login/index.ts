import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const C = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const J = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...C, "Content-Type": "application/json" },
  });
const H = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");
const S = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: C });
  try {
    const body = await req.json();
    const role = body.role === "admin"
      ? "admin"
      : body.role === "buyer"
      ? "buyer"
      : "";
    const secret = String(body.secret || "");
    if (!role || secret.length < 2 || secret.length > 200) {
      return J({ error: "INVALID_LOGIN" }, 400);
    }

    const sb = S();
    const { data, error } = await sb.rpc("sl_verify_access_secret", {
      p_role: role,
      p_secret: secret,
    });
    const credential = Array.isArray(data) ? data[0] : data;
    if (error || !credential) return J({ error: "INVALID_LOGIN" }, 403);

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes).map((value) =>
      value.toString(16).padStart(2, "0")
    ).join("");
    const tokenHash = await H(token);
    const lifetimeMs = role === "buyer"
      ? 7 * 24 * 60 * 60 * 1000
      : 12 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();

    await sb.from("sl_access_sessions").delete().lt(
      "expires_at",
      new Date().toISOString(),
    );
    const { error: storeError } = await sb.from("sl_access_sessions").insert({
      token_hash: tokenHash,
      access_role: role,
      channel_code: credential.channel_code || null,
      expires_at: expiresAt,
    });
    if (storeError) throw storeError;

    let channel = null;
    if (role === "buyer") {
      const { data: config } = await sb.from("sl_settings").select("channels")
        .eq("id", 1).single();
      channel = (config?.channels || []).find((entry: any) =>
        String(entry.code || "").trim().toUpperCase() ===
          String(credential.channel_code || "").toUpperCase()
      ) || null;
    }
    return J({ accessToken: token, expiresAt, channel });
  } catch (error) {
    return J({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
