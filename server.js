import express from "express";
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

// 🧠 Run yt-dlp safely
async function ytdlp(args) {
  const { stdout } = await exec("yt-dlp", args, {
    timeout: 30000,
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
  try {
    const url = cleanUrl(req.query.url);
    if (!url) return res.status(400).json({ error: "Bad URL" });

    const direct = await ytdlp(["-f", "bv*+ba/b", "-g", url]);

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="video.mp4"'
    );
    res.redirect(302, direct);
  } catch (e) {
    res.status(500).json({ error: "Download failed" });
  }
});

app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
