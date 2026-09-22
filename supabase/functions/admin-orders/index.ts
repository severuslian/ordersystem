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

async function session(sb: any, token: unknown, role: string) {
  if (typeof token !== "string" || token.length < 40) return null;
  const hash = await H(token);
  const { data } = await sb.from("sl_access_sessions")
    .select("access_role,channel_code,expires_at")
    .eq("token_hash", hash)
    .eq("access_role", role)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: C });
  try {
    const body = await req.json();
    const sb = S();
    const sess = await session(sb, body.accessToken, "admin");
    if (!sess) return J({ error: "ADMIN_REQUIRED" }, 403);

    if (body.action === "list") {
      const { data, error } = await sb.from("sl_orders").select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return J({ orders: data });
    }

    if (body.action === "create") {
      const code = String(body.channelCode || "").trim().toUpperCase();
      const currencyCode = String(body.currencyCode || "").trim().toUpperCase();
      if (!code || !currencyCode || !Array.isArray(body.items) || !body.items.length) {
        return J({ error: "INVALID_ORDER" }, 400);
      }

      const { data: cfg, error: cfgError } = await sb.from("sl_settings")
        .select("channels,currencies").eq("id", 1).single();
      if (cfgError) throw cfgError;
      const channel = (cfg?.channels || []).find((entry: any) =>
        String(entry.code || "").trim().toUpperCase() === code
      );
      const currency = (cfg?.currencies || []).find((entry: any) =>
        String(entry.code || "").trim().toUpperCase() === currencyCode
      );
      if (!channel) return J({ error: "INVALID_CHANNEL_CODE" }, 400);
      if (!currency || Number(currency.rate) <= 0) {
        return J({ error: "INVALID_CURRENCY" }, 400);
      }

      const { data, error } = await sb.rpc("sl_create_order_atomic", {
        p_buyer_email: String(channel.email || "").trim().toLowerCase(),
        p_channel_code: code,
        p_currency_code: currencyCode,
        p_language: String(channel.lang || body.language || "en"),
        p_items: body.items,
      });
      if (error) {
        const message = String(error.message || "");
        if (
          error.code === "23505" ||
          message.includes("sl_orders_one_pending_per_channel")
        ) return J({ error: "PENDING_ORDER_EXISTS" }, 409);
        if (message.includes("INSUFFICIENT_STOCK:")) {
          return J({
            error: "INSUFFICIENT_STOCK",
            productId: message.split("INSUFFICIENT_STOCK:")[1]?.trim() || "",
          }, 409);
        }
        if (
          message.includes("INVALID_QTY") ||
          message.includes("PRODUCT_NOT_FOUND") ||
          message.includes("EMPTY_ORDER")
        ) return J({ error: "INVALID_ITEMS" }, 400);
        throw error;
      }
      return J({ ok: true, order: data });
    }

    if (body.action === "status") {
      const { error } = await sb.rpc("sl_update_order_status_atomic", {
        p_order_id: body.orderId,
        p_status: body.status,
      });
      if (error) throw error;
      return J({ ok: true });
    }

    if (body.action === "update-items") {
      const { data, error } = await sb.rpc("sl_update_order_items_atomic", {
        p_order_id: body.orderId,
        p_items: body.items,
      });
      if (error) {
        const message = String(error.message || "");
        if (message.includes("INSUFFICIENT_STOCK:")) {
          return J({
            error: "INSUFFICIENT_STOCK",
            productId: message.split("INSUFFICIENT_STOCK:")[1]?.trim() || "",
          });
        }
        if (message.includes("ORDER_NOT_EDITABLE")) {
          return J({ error: "ORDER_NOT_EDITABLE" });
        }
        if (message.includes("EMPTY_ORDER")) return J({ error: "EMPTY_ORDER" });
        if (
          message.includes("INVALID_QTY") ||
          message.includes("INVALID_PRODUCT") ||
          message.includes("ITEM_SET_MISMATCH") ||
          message.includes("DUPLICATE_PRODUCT") ||
          message.includes("INVALID_PRICE") ||
          message.includes("INVALID_RATE") ||
          message.includes("CHANNEL_NOT_FOUND") ||
          message.includes("CURRENCY_NOT_FOUND")
        ) return J({ error: "INVALID_ITEMS" });
        throw error;
      }
      return J({ ok: true, order: data });
    }

    return J({ error: "BAD_ACTION" }, 400);
  } catch (error) {
    return J({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
