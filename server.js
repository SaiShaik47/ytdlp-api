import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import archiver from "archiver";
import fetch from "node-fetch";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "256kb" }));

// 🧒 Clean URL (stop bad input)
function cleanUrl(url) {
  if (!url) return null;
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http")) return null;
  if (trimmed.length > 2000) return null;
  return trimmed;
}

function getCookieArgs() {
  const cookiePath = process.env.YTDLP_COOKIES_PATH;
  const cookieData = process.env.YTDLP_COOKIES;
  const cookieBase64 = process.env.COOKIES_B64;

  if (cookiePath) {
    return {
      args: ["--cookies", cookiePath],
      cleanup: async () => {}
    };
  }

  if (cookieData) {
    const tmpPath = path.join(
      os.tmpdir(),
      `ytdlp-cookies-${process.pid}-${Date.now()}.txt`
    );
    fs.writeFileSync(tmpPath, cookieData, "utf8");
    return {
      args: ["--cookies", tmpPath],
      cleanup: async () => {
        await fs.promises.unlink(tmpPath).catch(() => {});
      }
    };
  }

  if (cookieBase64) {
    const decoded = Buffer.from(cookieBase64, "base64")
      .toString("utf8")
      .trim();
    if (!decoded) return { args: [], cleanup: async () => {} };

    const tmpPath = path.join(
      os.tmpdir(),
      `ytdlp-cookies-${process.pid}-${Date.now()}.txt`
    );
    fs.writeFileSync(tmpPath, `${decoded}\n`, "utf8");
    return {
      args: ["--cookies", tmpPath],
      cleanup: async () => {
        await fs.promises.unlink(tmpPath).catch(() => {});
      }
    };
  }

  return { args: [], cleanup: async () => {} };
}

function isImageUrl(url) {
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url);
}

function collectMedia(info) {
  const images = new Set();
  const videos = new Set();

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj.formats)) {
      for (const format of obj.formats) {
        if (format && typeof format.url === "string") {
          videos.add(format.url);
        }
      }
    }

    if (Array.isArray(obj.thumbnails)) {
      for (const thumb of obj.thumbnails) {
        if (thumb && typeof thumb.url === "string") {
          images.add(thumb.url);
        }
      }
    }

    if (typeof obj.url === "string" && isImageUrl(obj.url)) {
      images.add(obj.url);
    }

    if (Array.isArray(obj.entries)) {
      for (const entry of obj.entries) {
        walk(entry);
      }
    }

    for (const key of Object.keys(obj)) {
      walk(obj[key]);
    }
  }

  walk(info);

  return {
    images: [...images],
    videos: [...videos]
  };
}

function getCookieArgs() {
  const cookiePath = process.env.YTDLP_COOKIES_PATH;
  const cookieData = process.env.YTDLP_COOKIES;

  if (cookiePath) {
    return {
      args: ["--cookies", cookiePath],
      cleanup: async () => {}
    };
  }

  if (cookieData) {
    const tmpPath = path.join(
      os.tmpdir(),
      `ytdlp-cookies-${process.pid}-${Date.now()}.txt`
    );
    fs.writeFileSync(tmpPath, cookieData, "utf8");
    return {
      args: ["--cookies", tmpPath],
      cleanup: async () => {
        await fs.promises.unlink(tmpPath).catch(() => {});
      }
    };
  }

  return { args: [], cleanup: async () => {} };
}

// 🧠 Run yt-dlp safely
async function ytdlp(args, options = {}) {
  const { timeout = 30000 } = options;
  const { stdout } = await exec("yt-dlp", args, {
    timeout,
    maxBuffer: 1024 * 1024 * 10
  });
  return stdout.trim();
}

// ✅ Health check
app.get("/", (req, res) => {
  res.json({ ok: true, message: "ytdlp api running" });
});

// 🔍 INFO (gives download link)
app.post("/info", async (req, res) => {
  try {
    const url = cleanUrl(req.body.url);
    if (!url) return res.status(400).json({ error: "Bad URL" });

    const json = await ytdlp(["-J", url]);
    const info = JSON.parse(json);

    const direct = await ytdlp(["-f", "bv*+ba/b", "-g", url]);

    res.json({
      title: info.title,
      site: info.extractor,
      download: direct
    });
  } catch (e) {
    res.status(500).json({ error: "Failed", details: String(e) });
  }
});

// ▶️ STREAM (play video)
app.get("/stream", async (req, res) => {
  try {
    const url = cleanUrl(req.query.url);
    if (!url) return res.status(400).json({ error: "Bad URL" });

    const direct = await ytdlp(["-f", "bv*+ba/b", "-g", url]);
    res.redirect(302, direct);
  } catch (e) {
    res.status(500).json({ error: "Stream failed" });
  }
});

// ⬇️ DOWNLOAD (FORCE DOWNLOAD)
app.get("/download", async (req, res) => {
  const url = cleanUrl(req.query.url);
  if (!url) return res.status(400).json({ error: "Bad URL" });

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytdlp-"));
  const outFile = path.join(tmpDir, `video-${Date.now()}.mp4`);
  const { args: cookieArgs, cleanup: cleanupCookies } = getCookieArgs();

  try {
    const args = [
      ...cookieArgs,
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      "mp4",
      "-o",
      outFile,
      url
    ];

    await ytdlp(args, { timeout: 120000 });

    res.download(outFile, "video.mp4", async (err) => {
      await fs.promises.unlink(outFile).catch(() => {});
      await fs.promises.rmdir(tmpDir).catch(() => {});
      await cleanupCookies();

      if (err && !res.headersSent) {
        res.status(500).json({ error: "Download failed" });
      }
    });
  } catch (e) {
    await fs.promises.unlink(outFile).catch(() => {});
    await fs.promises.rmdir(tmpDir).catch(() => {});
    await cleanupCookies();
    res.status(500).json({
      error: "Download failed",
      details: String(e?.message || e)
    });
  }
});

// 🧩 MEDIA (list images + videos)
app.post("/media", async (req, res) => {
  const url = cleanUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: "Bad URL" });

  const { args: cookieArgs, cleanup: cleanupCookies } = getCookieArgs();

  try {
    const json = await ytdlp(
      [...cookieArgs, "-J", "--no-warnings", url],
      { timeout: 45000 }
    );
    const info = JSON.parse(json);
    const media = collectMedia(info);

    res.json({
      title: info?.title ?? null,
      extractor: info?.extractor ?? null,
      images: media.images,
      videos: media.videos.slice(0, 25)
    });
  } catch (e) {
    res.status(500).json({
      error: "Media extraction failed",
      details: String(e?.message || e)
    });
  } finally {
    await cleanupCookies();
  }
});

// 🖼️ IMAGE (download one image)
app.get("/image", async (req, res) => {
  try {
    const imageUrl = cleanUrl(req.query?.url);
    if (!imageUrl) return res.status(400).json({ error: "Bad image url" });

    const response = await fetch(imageUrl, { redirect: "follow" });
    if (!response.ok) {
      return res
        .status(502)
        .json({ error: "Failed fetching image", status: response.status });
    }

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const extension = contentType.includes("png")
      ? "png"
      : contentType.includes("jpeg")
        ? "jpg"
        : contentType.includes("webp")
          ? "webp"
          : "img";

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="image.${extension}"`
    );

    response.body.pipe(res);
  } catch (e) {
    res.status(500).json({
      error: "image download failed",
      details: String(e?.message || e)
    });
  }
});

// 🗂️ X-IMAGES (download all images as zip)
app.get("/x-images", async (req, res) => {
  const post = cleanUrl(req.query?.post);
  if (!post) return res.status(400).json({ error: "Bad post url" });

  const { args: cookieArgs, cleanup: cleanupCookies } = getCookieArgs();

  try {
    const json = await ytdlp(
      [...cookieArgs, "-J", "--no-warnings", post],
      { timeout: 45000 }
    );
    const info = JSON.parse(json);
    const media = collectMedia(info);
    const unique = [...new Set(media.images)].filter((url) => isImageUrl(url));

    if (unique.length === 0) {
      return res
        .status(404)
        .json({ error: "No images found in this post." });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="x-images.zip"'
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      throw err;
    });
    archive.pipe(res);

    let index = 1;
    for (const url of unique.slice(0, 20)) {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) continue;
      const extension = url.includes(".png")
        ? "png"
        : url.includes(".webp")
          ? "webp"
          : "jpg";
      archive.append(response.body, { name: `image-${index}.${extension}` });
      index += 1;
    }

    await archive.finalize();
  } catch (e) {
    res.status(500).json({
      error: "zip failed",
      details: String(e?.message || e)
    });
  } finally {
    await cleanupCookies();
  }
});

app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
