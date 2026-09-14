const express = require("express");
const path = require("path");
const { nanoid } = require("nanoid");
const { getSupabase, requireSupabase } = require("../supabase");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const bucket = process.env.SUPABASE_STORAGE_BUCKET || "viewora-assets";
const maxModelBytes = Number(process.env.MAX_MODEL_BYTES || 50 * 1024 * 1024);
const maxThumbnailBytes = Number(process.env.MAX_THUMBNAIL_BYTES || 5 * 1024 * 1024);
const maxStorageBytes = Number(process.env.MAX_STORAGE_BYTES_PER_USER || 1024 * 1024 * 1024);
const thumbnailExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function fail(res, status, error) {
  return res.status(status).json({ error });
}
function extension(name) {
  return path.extname(name || "").toLowerCase();
}
function toProject(row, thumbnailUrl) {
  return {
    id: row.id,
    name: row.name,
    shareToken: row.share_token,
    isPublic: row.is_public,
    thumbnailUrl: thumbnailUrl || null,
    createdAt: row.created_at
  };
}
async function signedUrl(supabase, key) {
  if (!key) return null;
  return requireSupabase(await supabase.storage.from(bucket).createSignedUrl(key, 3600)).signedUrl;
}
async function owned(supabase, id, userId) {
  return requireSupabase(
    await supabase.from("projects").select("*").eq("id", id).eq("user_id", userId).maybeSingle()
  );
}
async function usage(supabase, userId) {
  const rows = requireSupabase(
    await supabase.from("projects").select("model_size_bytes,thumbnail_size_bytes").eq("user_id", userId)
  );
  return {
    count: rows.length,
    bytes: rows.reduce((n, r) => n + Number(r.model_size_bytes || 0) + Number(r.thumbnail_size_bytes || 0), 0)
  };
}
function uploadKey(userId, kind, ext) {
  return `users/${userId}/${kind}/${nanoid()}${ext}`;
}

router.post("/upload-url", requireAuth, async (req, res, next) => {
  const { name, filename, size } = req.body || {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100)
    return fail(res, 400, "Project name must be 1-100 characters");
  if (extension(filename) !== ".glb" || !Number.isSafeInteger(size) || size < 12 || size > maxModelBytes)
    return fail(res, 400, "Upload a GLB model within the file-size limit");
  try {
    const supabase = getSupabase();
    const current = await usage(supabase, req.userId);
    if (current.count >= Number(process.env.MAX_PROJECTS_PER_USER || 20))
      return fail(res, 429, "Project limit reached for this account");
    if (current.bytes + size > maxStorageBytes)
      return fail(res, 413, "Storage limit reached for this account");
    const key = uploadKey(req.userId, "models", ".glb");
    const shareToken = nanoid(12);
    const project = requireSupabase(
      await supabase
        .from("projects")
        .insert({
          user_id: req.userId,
          name: name.trim(),
          model_filename: key,
          model_size_bytes: size,
          share_token: shareToken
        })
        .select("id")
        .single()
    );
    try {
      const upload = requireSupabase(await supabase.storage.from(bucket).createSignedUploadUrl(key));
      return res.status(201).json({
        id: project.id,
        shareToken,
        shareUrl: `/view/${shareToken}`,
        uploadUrl: upload.signedUrl,
        uploadToken: upload.token
      });
    } catch (error) {
      await supabase.from("projects").delete().eq("id", project.id);
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const supabase = getSupabase();
    let q = supabase
      .from("projects")
      .select("id,name,share_token,is_public,thumbnail_filename,created_at")
      .eq("user_id", req.userId);
    if (req.query.visibility === "public") q = q.eq("is_public", true);
    if (req.query.visibility === "private") q = q.eq("is_public", false);
    if (typeof req.query.query === "string" && req.query.query.trim()) {
      q = q.ilike("name", `%${req.query.query.trim().replace(/[%_]/g, "\\$&").slice(0, 100)}%`);
    }
    const order =
      req.query.sort === "oldest"
        ? { ascending: true }
        : req.query.sort === "name"
          ? { ascending: true }
          : { ascending: false };
    const rows = requireSupabase(await q.order(req.query.sort === "name" ? "name" : "created_at", order));
    return res.json(
      await Promise.all(
        rows.map(async (row) => toProject(row, await signedUrl(supabase, row.thumbnail_filename)))
      )
    );
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/editor", requireAuth, async (req, res, next) => {
  try {
    const s = getSupabase();
    const p = await owned(s, req.params.id, req.userId);
    if (!p) return fail(res, 404, "Project nahi mila");
    const rooms = requireSupabase(
      await s.from("rooms").select("label,x,y,z,rx,ry,rz").eq("project_id", p.id)
    );
    return res.json({
      name: p.name,
      modelUrl: await signedUrl(s, p.model_filename),
      rooms,
      start:
        p.start_x === null
          ? null
          : {
              x: p.start_x,
              y: p.start_y,
              z: p.start_z,
              rx: p.start_rx || 0,
              ry: p.start_ry || 0,
              rz: p.start_rz || 0
            }
    });
  } catch (e) {
    return next(e);
  }
});

router.post("/:id/thumbnail-upload-url", requireAuth, async (req, res, next) => {
  const { filename, size, contentType } = req.body || {};
  if (
    !thumbnailExtensions.has(extension(filename)) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > maxThumbnailBytes
  ) {
    return fail(res, 400, "Thumbnail must be a PNG, JPG, or WebP image up to 5MB");
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType))
    return fail(res, 400, "Invalid thumbnail type");
  try {
    const s = getSupabase();
    const p = await owned(s, req.params.id, req.userId);
    if (!p) return fail(res, 404, "Project nahi mila");
    const current = await usage(s, req.userId);
    if (current.bytes - Number(p.thumbnail_size_bytes || 0) + size > maxStorageBytes)
      return fail(res, 413, "Storage limit reached for this account");
    const key = uploadKey(req.userId, "thumbnails", extension(filename));
    requireSupabase(
      await s.from("projects").update({ thumbnail_filename: key, thumbnail_size_bytes: size }).eq("id", p.id)
    );
    if (p.thumbnail_filename) await s.storage.from(bucket).remove([p.thumbnail_filename]);
    const upload = requireSupabase(await s.storage.from(bucket).createSignedUploadUrl(key));
    return res.json({ uploadUrl: upload.signedUrl, uploadToken: upload.token });
  } catch (e) {
    return next(e);
  }
});

router.delete("/:id/thumbnail", requireAuth, async (req, res, next) => {
  try {
    const s = getSupabase();
    const p = await owned(s, req.params.id, req.userId);
    if (!p) return fail(res, 404, "Project nahi mila");
    requireSupabase(
      await s.from("projects").update({ thumbnail_filename: null, thumbnail_size_bytes: 0 }).eq("id", p.id)
    );
    if (p.thumbnail_filename) await s.storage.from(bucket).remove([p.thumbnail_filename]);
    return res.json({ ok: true });
  } catch (e) {
    return next(e);
  }
});

router.put("/:id/rooms", requireAuth, async (req, res, next) => {
  const rooms = Array.isArray(req.body?.rooms) ? req.body.rooms : [];
  if (
    !rooms.every(
      (r) =>
        typeof r.label === "string" &&
        r.label.trim() &&
        [r.x, r.y, r.z, r.rx ?? 0, r.ry ?? 0, r.rz ?? 0].every(Number.isFinite)
    )
  )
    return fail(res, 400, "Rooms data galat format mein hai");
  try {
    const s = getSupabase();
    const p = await owned(s, req.params.id, req.userId);
    if (!p) return fail(res, 404, "Project nahi mila");
    requireSupabase(await s.from("rooms").delete().eq("project_id", p.id));
    if (rooms.length)
      requireSupabase(
        await s.from("rooms").insert(
          rooms.map((r) => ({
            project_id: p.id,
            label: r.label.trim(),
            x: r.x,
            y: r.y,
            z: r.z,
            rx: r.rx || 0,
            ry: r.ry || 0,
            rz: r.rz || 0
          }))
        )
      );
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "start")) {
      const start = req.body.start;
      const values =
        start === null
          ? { start_x: null, start_y: null, start_z: null, start_rx: null, start_ry: null, start_rz: null }
          : {
              start_x: start.x,
              start_y: start.y,
              start_z: start.z,
              start_rx: start.rx || 0,
              start_ry: start.ry || 0,
              start_rz: start.rz || 0
            };
      requireSupabase(await s.from("projects").update(values).eq("id", p.id));
    }
    return res.json({ ok: true, count: rooms.length });
  } catch (e) {
    return next(e);
  }
});

router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const s = getSupabase();
    const p = await owned(s, req.params.id, req.userId);
    if (!p) return fail(res, 404, "Project nahi mila");
    requireSupabase(await s.from("projects").delete().eq("id", p.id));
    const keys = [p.model_filename, p.thumbnail_filename].filter(Boolean);
    if (keys.length) await s.storage.from(bucket).remove(keys);
    return res.json({
      ok: true,
      cleanup: { model: "removed", thumbnail: p.thumbnail_filename ? "removed" : "not_applicable" }
    });
  } catch (e) {
    return next(e);
  }
});

router.get("/public/:token", async (req, res, next) => {
  try {
    const s = getSupabase();
    const p = requireSupabase(
      await s
        .from("projects")
        .select("*")
        .eq("share_token", req.params.token)
        .eq("is_public", true)
        .maybeSingle()
    );
    if (!p) return fail(res, 404, "Project nahi mila");
    await s
      .from("projects")
      .update({ view_count: Number(p.view_count || 0) + 1 })
      .eq("id", p.id);
    const rooms = requireSupabase(
      await s.from("rooms").select("label,x,y,z,rx,ry,rz").eq("project_id", p.id)
    );
    return res.json({
      name: p.name,
      modelUrl: await signedUrl(s, p.model_filename),
      rooms,
      start:
        p.start_x === null
          ? null
          : {
              x: p.start_x,
              y: p.start_y,
              z: p.start_z,
              rx: p.start_rx || 0,
              ry: p.start_ry || 0,
              rz: p.start_rz || 0
            }
    });
  } catch (e) {
    return next(e);
  }
});

router.use((err, req, res, _next) => {
  console.error(err);
  return fail(res, 500, "Unexpected server error");
});
module.exports = router;
