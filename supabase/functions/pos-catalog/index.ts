import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const POS_ORIGIN = "https://severus-lian-offline-pos.snowyimage1.chatgpt.site";
const CATALOG_COLOR = "#d9c0a7";
const H = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const S = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function cors(req: Request) {
  if ((req.headers.get("Origin") || "") !== POS_ORIGIN) return null;
  return {
    "Access-Control-Allow-Origin": POS_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type, if-none-match",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Expose-Headers": "ETag",
    "Vary": "Origin",
  };
}
function J(req: Request, body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(cors(req) || {}),
      ...extra,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

Deno.serve(async (req) => {
  const c = cors(req);
  if (!c) return new Response("Forbidden origin", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  if (req.method !== "GET") return J(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (token.length < 40) return J(req, { error: "DEVICE_TOKEN_REQUIRED" }, 401);

    const sb = S();
    const tokenHash = await H(token);
    const { data: device } = await sb.from("sl_pos_devices")
      .select("id,scope,expires_at,revoked_at")
      .eq("token_hash", tokenHash)
      .eq("scope", "catalog:read")
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (!device) return J(req, { error: "DEVICE_TOKEN_INVALID" }, 403);

    const [{ data: categoryRows, error: categoryError }, { data: productRows, error: productError }] = await Promise.all([
      sb.from("sl_categories").select("public_id,name,sort_order").order("sort_order"),
      sb.from("sl_products").select("id,barcode,name,price,stock,img,category_ids,sort_order").order("sort_order"),
    ]);
    if (categoryError) throw categoryError;
    if (productError) throw productError;

    const categoryIds = new Set((categoryRows || []).map((row: any) => String(row.public_id)));
    const categories = (categoryRows || []).map((row: any) => ({
      id: String(row.public_id),
      name: String(row.name || ""),
      order: Number(row.sort_order || 0) + 1,
      color: CATALOG_COLOR,
    }));
    const products = (productRows || []).map((row: any) => {
      const categoryId = String(row.category_ids?.[0] || "");
      if (!categoryId || !categoryIds.has(categoryId)) throw new Error(`INVALID_CATEGORY_REFERENCE:${row.id}`);
      return {
        id: String(row.id),
        sku: String(row.barcode || ""),
        barcode: String(row.barcode || ""),
        name: String(row.name || ""),
        categoryId,
        price: Number(row.price || 0),
        cost: 0,
        stock: Number(row.stock || 0),
        photo: row.img || "",
        color: CATALOG_COLOR,
      };
    });

    const stablePayload = JSON.stringify({ schema: "severus-pos-catalog", version: 1, categories, products });
    const etag = `"${await H(stablePayload)}"`;
    await sb.from("sl_pos_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", device.id);
    const requestedEtag = (req.headers.get("If-None-Match") || "").replace(/^W\//, "");
    if (requestedEtag === etag) return J(req, null, 304, { ETag: etag });

    return J(req, {
      schema: "severus-pos-catalog",
      version: 1,
      generatedAt: new Date().toISOString(),
      categories,
      products,
      promotions: [],
      gifts: [],
      payments: [],
    }, 200, { ETag: etag });
  } catch (error) {
    console.error("pos-catalog error", error instanceof Error ? error.message : "unknown");
    return J(req, { error: "CATALOG_FAILED" }, 500);
  }
});
