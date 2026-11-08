import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const ALLOWED_ORIGINS = new Set(["https://severuslian.github.io", "null"]);
const H = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const S = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function cors(req: Request) {
  const origin = req.headers.get("Origin") || "null";
  if (!ALLOWED_ORIGINS.has(origin)) return null;
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

Deno.serve(async (req) => {
  const c = cors(req);
  if (!c) return new Response("Forbidden origin", { status: 403 });
  if (req.method === "OPTIONS") return new Response("ok", { headers: c });
  if (req.method !== "POST") return J(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const body = await req.json();
    const token = String(body.accessToken || "");
    if (token.length < 40) return J(req, { error: "LOGIN_REQUIRED" }, 403);
    const sb = S();
    const { data: session } = await sb.from("sl_access_sessions")
      .select("access_role,channel_code,expires_at")
      .eq("token_hash", await H(token))
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (!session || !["admin", "buyer"].includes(session.access_role)) return J(req, { error: "LOGIN_REQUIRED" }, 403);

    const [{ data: products, error: productError }, { data: categories, error: categoryError }] = await Promise.all([
      sb.from("sl_products").select("id,name,name_en,barcode,price,size,material,color,weight,note,img,foreign_prices,channel_prices,cats,category_ids,stock,stock_low,sort_order,created_at,updated_at").order("sort_order"),
      sb.from("sl_categories").select("public_id,name,sort_order,created_at").order("sort_order"),
    ]);
    if (productError) throw productError;
    if (categoryError) throw categoryError;

    if (session.access_role === "admin") return J(req, { products, categories });

    const { data: config, error: configError } = await sb.from("sl_settings").select("channels").eq("id", 1).single();
    if (configError) throw configError;
    const channel = (config?.channels || []).find((entry: any) =>
      String(entry.code || "").trim().toUpperCase() === String(session.channel_code || "").trim().toUpperCase()
    );
    if (!channel) return J(req, { error: "CHANNEL_NOT_FOUND" }, 403);
    const safeProducts = (products || []).filter((product: any) =>
      product.channel_prices?.[channel.name]?.hidden !== true
    ).map((product: any) => ({
      ...product,
      channel_prices: product.channel_prices?.[channel.name]
        ? { [channel.name]: product.channel_prices[channel.name] }
        : {},
    }));
    return J(req, { products: safeProducts, categories });
  } catch (error) {
    console.error("catalog-read error", error instanceof Error ? error.message : "unknown");
    return J(req, { error: "CATALOG_READ_FAILED" }, 500);
  }
});
