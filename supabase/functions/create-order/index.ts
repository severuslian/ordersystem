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
const E = (value: unknown) =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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

async function notifySlack(order: any) {
  const webhook = Deno.env.get("SLACK_ORDER_WEBHOOK_URL");
  if (!webhook) return { configured: false, sent: false };
  const amount = Number(order.total_amount || 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const payload = {
    text: `SEVERUS LIAN 新訂單｜${order.channel_name}｜${order.order_no}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🔔 收到新訂單", emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*通路商*\n${E(order.channel_name)}` },
          { type: "mrkdwn", text: `*訂單編號*\n${E(order.order_no)}` },
          { type: "mrkdwn", text: `*商品件數*\n${Number(order.total_qty || 0)}` },
          { type: "mrkdwn", text: `*訂單金額*\n${E(order.currency_code)} ${amount}` },
        ],
      },
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "開啟訂單系統", emoji: true },
          url: "https://severuslian.github.io/ordersystem/catalog-tool.html",
          style: "primary",
        }],
      },
    ],
  };
  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error("Slack notification failed", response.status, await response.text());
      return { configured: true, sent: false };
    }
    return { configured: true, sent: true };
  } catch (error) {
    console.error("Slack notification error", error);
    return { configured: true, sent: false };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: C });
  try {
    const body = await req.json();
    const sb = S();
    const sess = await session(sb, body.accessToken, "buyer");
    // This is a business-session error rather than a platform-auth error. Returning
    // JSON with HTTP 200 lets the browser preserve and display the exact recovery step.
    if (!sess) return J({ error: "LOGIN_REQUIRED" });

    const code = String(body.channelCode || "").trim().toUpperCase();
    if (!code || code !== String(sess.channel_code || "").toUpperCase()) {
      return J({ error: "INVALID_CHANNEL_CODE" }, 403);
    }
    const { data: config, error: configError } = await sb.from("sl_settings")
      .select("channels").eq("id", 1).single();
    if (configError) throw configError;
    const channel = (config?.channels || []).find((entry: any) =>
      String(entry.code || "").trim().toUpperCase() === code
    );
    if (!channel) return J({ error: "INVALID_CHANNEL_CODE" }, 403);

    const { data, error } = await sb.rpc("sl_create_order_atomic", {
      p_buyer_email: String(channel.email || "").trim().toLowerCase(),
      p_channel_code: code,
      p_currency_code: body.currencyCode,
      p_language: String(channel.lang || body.language || "en"),
      p_items: body.items,
    });
    if (error) {
      if (
        error.code === "23505" ||
        String(error.message || "").includes("sl_orders_one_pending_per_channel")
      ) return J({ error: "PENDING_ORDER_EXISTS" });
      return J({ error: error.message || "ORDER_FAILED" }, 400);
    }

    const orderId = Array.isArray(data) ? data[0]?.id : data?.id;
    let slack = {
      configured: Boolean(Deno.env.get("SLACK_ORDER_WEBHOOK_URL")),
      sent: false,
    };
    if (orderId) {
      const { data: order, error: orderError } = await sb.from("sl_orders")
        .select("order_no,channel_name,total_qty,total_amount,currency_code")
        .eq("id", orderId).single();
      if (orderError) console.error("Order notification lookup failed", orderError);
      else slack = await notifySlack(order);
    }
    return J({ order: data, notification: { slack } });
  } catch (error) {
    return J({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
