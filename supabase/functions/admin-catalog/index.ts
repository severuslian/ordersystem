import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const ADMIN_ORIGINS = new Set(["https://severuslian.github.io", "null"]);
const STORAGE_BUCKET = "product-images";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

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
  if (!ADMIN_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function J(req: Request, body: unknown, status = 200) {
  const c = cors(req) || {};
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...c, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function adminSession(sb: ReturnType<typeof S>, token: unknown) {
  if (typeof token !== "string" || token.length < 40) return null;
  const { data } = await sb.from("sl_access_sessions")
    .select("access_role,expires_at")
    .eq("token_hash", await H(token))
    .eq("access_role", "admin")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data || null;
}

function safeName(value: string) {
  return String(value || "image")
    .normalize("NFKD")
    .replace(/[\/\\?%*:|"<>#]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "image";
}

Deno.serve(async (req) => {
  const c = cors(req);
  if (!c) return new Response("Forbidden origin", { status: 403 });
  if (req.method === "OPTIONS") return new Response("ok", { headers: c });
  if (req.method !== "POST") return J(req, { error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const sb = S();
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const accessToken = form.get("accessToken");
      if (!await adminSession(sb, accessToken)) return J(req, { error: "ADMIN_REQUIRED" }, 403);
      if (String(form.get("action") || "") !== "upload-image") return J(req, { error: "BAD_ACTION" }, 400);

      const file = form.get("file");
      const productId = String(form.get("productId") || "").trim();
      if (!(file instanceof File) || !productId) return J(req, { error: "INVALID_IMAGE" }, 400);
      if (!IMAGE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
        return J(req, { error: "INVALID_IMAGE_TYPE_OR_SIZE" }, 400);
      }

      const path = `products/${safeName(productId)}/${Date.now()}-${safeName(file.name)}`;
      const { error } = await sb.storage.from(STORAGE_BUCKET).upload(path, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type,
      });
      if (error) throw error;
      const { data } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
      return J(req, { ok: true, path, publicUrl: data.publicUrl });
    }

    const body = await req.json();
    if (!await adminSession(sb, body.accessToken)) return J(req, { error: "ADMIN_REQUIRED" }, 403);

    if (body.action === "sync") {
      if (!Array.isArray(body.categories) || !Array.isArray(body.products) || body.categories.length > 1000 || body.products.length > 5000) {
        return J(req, { error: "INVALID_CATALOG_PAYLOAD" }, 400);
      }
      const { data, error } = await sb.rpc("sl_admin_catalog_sync", {
        p_categories: body.categories,
        p_products: body.products,
      });
      if (error) return J(req, { error: error.message || "SYNC_FAILED" }, 400);
      return J(req, { ok: true, result: data });
    }

    if (body.action === "delete-product") {
      const id = String(body.productId || "").trim();
      if (!id) return J(req, { error: "INVALID_PRODUCT" }, 400);
      const { error } = await sb.from("sl_products").delete().eq("id", id);
      if (error) throw error;
      return J(req, { ok: true });
    }

    if (body.action === "delete-category") {
      const categoryId = String(body.categoryId || "").trim();
      if (!categoryId) return J(req, { error: "INVALID_CATEGORY" }, 400);
      const { count, error: countError } = await sb.from("sl_products")
        .select("id", { count: "exact", head: true })
        .contains("category_ids", [categoryId]);
      if (countError) throw countError;
      if ((count || 0) > 0) return J(req, { error: "CATEGORY_IN_USE" }, 409);
      const { error } = await sb.from("sl_categories").delete().eq("public_id", categoryId);
      if (error) throw error;
      return J(req, { ok: true });
    }

    if (body.action === "delete-image") {
      const path = String(body.path || "").trim();
      if (!path.startsWith("products/") || path.includes("..")) return J(req, { error: "INVALID_IMAGE_PATH" }, 400);
      const { error } = await sb.storage.from(STORAGE_BUCKET).remove([path]);
      if (error) throw error;
      return J(req, { ok: true });
    }

    return J(req, { error: "BAD_ACTION" }, 400);
  } catch (error) {
    console.error("admin-catalog error", error instanceof Error ? error.message : "unknown");
    return J(req, { error: "ADMIN_CATALOG_FAILED" }, 500);
  }
});
