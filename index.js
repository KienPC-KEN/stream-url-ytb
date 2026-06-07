import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import search from "@distube/ytsr";
import youtubeDlExec from "youtube-dl-exec";
const { create } = youtubeDlExec;

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const SEARCH_CACHE_TTL = 60 * 10; // 10 phút
const AUDIO_CACHE_TTL = 60 * 60 * 5; // 5 giờ (URL expire sau ~6h)

// ─────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────

const searchCache = new NodeCache({
  stdTTL: SEARCH_CACHE_TTL,
  checkperiod: 120,
});
const audioCache = new NodeCache({ stdTTL: AUDIO_CACHE_TTL, checkperiod: 300 });

// Dedup: tránh gọi trùng request đang pending
const pendingSearches = new Map();
const pendingAudio = new Map();

// ─────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────

const t = () => performance.now();
const logTime = (label, start) =>
  console.log(`⚡ ${label}: ${(t() - start).toFixed(0)}ms`);

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retry = async (fn, retries = 2, delay = 500) => {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < retries) await sleep(delay);
    }
  }
  throw lastError;
};

// Wrap một async task với dedup: nếu đang pending thì chờ chung
const withDedup = (map, key, fn) => {
  if (map.has(key)) return map.get(key);
  const promise = fn().finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
};

// ─────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────

const FILTER_KEYWORDS = ["karaoke", "live", "remix", "slowed", "8d", "reverb"];

const parseDurationSeconds = (duration) => {
  if (!duration) return 0;
  const parts = duration.split(":").map(Number);
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
};

const normalizeResults = (items = []) =>
  items
    .filter((item) => {
      if (item.type !== "video") return false;
      const title = (item.name || "").toLowerCase();
      if (FILTER_KEYWORDS.some((kw) => title.includes(kw))) return false;
      if (parseDurationSeconds(item.duration) > 600) return false;
      return true;
    })
    .slice(0, 5)
    .map((item) => ({
      title: item.name,
      url: item.url,
      thumbnail: item.thumbnail?.url ?? item.bestThumbnail?.url,
      duration: item.duration,
    }));

const searchYouTube = async (query) => {
  const key = `search:${query.toLowerCase().trim()}`;
  const cached = searchCache.get(key);

  if (cached) {
    console.log(`🟢 SEARCH HIT: ${query}`);
    return cached;
  }

  console.log(`🟡 SEARCH MISS: ${query}`);

  return withDedup(pendingSearches, key, () =>
    retry(async () => {
      const start = t();
      const res = await search(query, { limit: 15, safeSearch: false });
      logTime(`search "${query}"`, start);

      const filtered = normalizeResults(res.items);
      searchCache.set(key, filtered);
      return filtered;
    }),
  );
};

// ─────────────────────────────────────────────────────────────
// AUDIO URL  — dùng yt-dlp (ổn định, luôn được update)
// ─────────────────────────────────────────────────────────────

// youtube-dl-exec tự bundle yt-dlp binary, không cần cài tay
const ytDlp = create("yt-dlp");

const fetchAudioUrl = async (videoUrl) =>
  retry(async () => {
    const start = t();

    // --dump-json: chỉ lấy metadata, không download file
    const info = await ytDlp(videoUrl, {
      dumpSingleJson: true,
      noPlaylist: true,
      format: "bestaudio[ext=m4a]/bestaudio",
      noWarnings: true,
      cookies: "./youtube-cookies.txt",
    });

    if (!info?.url) throw new Error("No audio URL from yt-dlp");

    logTime(`audio url fetch (yt-dlp)`, start);

    return {
      url: info.url,
      mimeType: info.ext === "m4a" ? "audio/mp4" : `audio/${info.ext}`,
      bitrate: info.abr ?? info.tbr,
      duration: info.duration,
      expireAt: Date.now() + AUDIO_CACHE_TTL * 1000,
    };
  });

const getAudio = async (videoUrl) => {
  const key = `audio:${videoUrl}`;
  const cached = audioCache.get(key);

  if (cached) {
    console.log(`🟢 AUDIO HIT`);
    return cached;
  }

  console.log(`🟡 AUDIO MISS`);

  return withDedup(pendingAudio, key, () =>
    fetchAudioUrl(videoUrl).then((data) => {
      audioCache.set(key, data);
      return data;
    }),
  );
};

// ─────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────

app.get("/", (_, res) => res.json({ status: "ok", service: "music-backend" }));

// ─── GET /music/search?q=... ──────────────────────────────────

app.get("/music/search", async (req, res) => {
  const start = t();
  try {
    const query = String(req.query.q || "").trim();
    if (!query)
      return res.status(400).json({ message: "Missing query param: q" });

    const results = await searchYouTube(query);
    logTime("/music/search TOTAL", start);
    return res.json(results);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /music/audio?url=... ─────────────────────────────────
//     Trả về audio URL từ một YouTube URL cụ thể

app.get("/music/audio", async (req, res) => {
  const start = t();
  try {
    const url = String(req.query.url || "").trim();
    if (!url)
      return res.status(400).json({ message: "Missing query param: url" });

    const data = await getAudio(url);
    logTime("/music/audio TOTAL", start);
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST /music/audio  { "query": "tên bài" } ───────────────
//     Search + tự động lấy audio URL của kết quả đầu tiên

app.post("/music/audio", async (req, res) => {
  const start = t();
  try {
    const query = String(req.body.query || "").trim();

    if (!query)
      return res.status(400).json({ message: "Missing body field: query" });

    const results = await searchYouTube(query);
    if (!results.length)
      return res.status(404).json({ message: "No results found" });

    const best = results[0];
    const audio = await getAudio(best.url);

    logTime("POST /music/audio TOTAL", start);
    return res.json({ query, video: best, audio });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

import { execSync } from "child_process";

try {
  console.log(execSync("which yt-dlp").toString());
} catch {
  console.log("yt-dlp not found");
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
