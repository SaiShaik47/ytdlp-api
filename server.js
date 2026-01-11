import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "256kb" }));

// 🧒 Clean URL (stop bad input)
function cleanUrl(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (url.length > 2000) return null;
  return url;
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
    maxBuffer: 1024 * 1024 * 5
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

app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
