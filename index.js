import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import { Innertube } from "youtubei.js";
import { google } from "googleapis";
import "dotenv/config";

const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY,
});

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const SEARCH_CACHE_TTL = 60 * 10;
const AUDIO_CACHE_TTL = 60 * 60 * 3;
const MAX_DURATION_SEC = 600;
const RACE_TOP_N = 3;

// ─────────────────────────────────────────────────────────────
// CACHE & DEDUP
// ─────────────────────────────────────────────────────────────

const searchCache = new NodeCache({
  stdTTL: SEARCH_CACHE_TTL,
  checkperiod: 120,
});
const audioCache = new NodeCache({ stdTTL: AUDIO_CACHE_TTL, checkperiod: 300 });

const pendingSearch = new Map();
const pendingAudio = new Map();
const pendingCombo = new Map();

const withDedup = (map, key, fn) => {
  if (map.has(key)) return map.get(key);
  const promise = fn().finally(() => map.delete(key));
  map.set(key, promise);
  return promise;
};

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────

const now = () => performance.now();
const logTime = (label, start) =>
  console.log(`⚡ ${label}: ${(now() - start).toFixed(0)}ms`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const retry = async (fn, retries = 2, delay = 300) => {
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

const parseDuration = (iso) => {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (
    parseInt(m[1] || 0) * 3600 + parseInt(m[2] || 0) * 60 + parseInt(m[3] || 0)
  );
};

const isFiltered = (title = "", durationSec = 0) => {
  if (title.toLowerCase().includes("karaoke")) return true;
  if (durationSec > MAX_DURATION_SEC) return true;
  return false;
};

// ─────────────────────────────────────────────────────────────
// SEARCH — YouTube Data API v3
// ─────────────────────────────────────────────────────────────

const searchYouTube = (query) => {
  const key = `search:${query.toLowerCase().trim()}`;
  const cached = searchCache.get(key);
  if (cached) {
    console.log(`🟢 SEARCH HIT: ${query}`);
    return Promise.resolve(cached);
  }

  console.log(`🟡 SEARCH MISS: ${query}`);

  return withDedup(pendingSearch, key, () =>
    retry(async () => {
      const start = now();

      const searchRes = await youtube.search.list({
        part: ["id"],
        q: query,
        type: ["video"],
        videoCategoryId: "10",
        maxResults: 10,
      });

      const videoIds = (searchRes.data.items ?? [])
        .map((i) => i.id?.videoId)
        .filter(Boolean);

      if (!videoIds.length) return [];

      const detailRes = await youtube.videos.list({
        part: ["snippet", "contentDetails"],
        id: videoIds,
      });

      const items = (detailRes.data.items ?? [])
        .map((v) => {
          const durationSec = parseDuration(v.contentDetails?.duration);
          const title = v.snippet?.title ?? "";
          if (isFiltered(title, durationSec)) return null;
          return {
            id: v.id,
            title,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            thumbnail:
              v.snippet?.thumbnails?.medium?.url ??
              v.snippet?.thumbnails?.default?.url ??
              "",
            duration: durationSec,
          };
        })
        .filter(Boolean);

      logTime(`YouTube API search "${query}"`, start);
      searchCache.set(key, items);
      return items;
    }),
  );
};

// ─────────────────────────────────────────────────────────────
// AUDIO — youtubei.js với TV_EMBEDDED (ổn định nhất)
// ─────────────────────────────────────────────────────────────

const pickBestAudioFormat = (info) => {
  const sd = info.streaming_data;
  if (!sd) return null;

  const all = [...(sd.adaptive_formats ?? []), ...(sd.formats ?? [])];
  const audioOnly = all.filter((f) => f.has_audio && !f.has_video && f.url);
  const pool = audioOnly.length
    ? audioOnly
    : all.filter((f) => f.has_audio && f.url);
  if (!pool.length) return null;

  return pool.sort(
    (a, b) =>
      (b.average_bitrate ?? b.bitrate ?? 0) -
      (a.average_bitrate ?? a.bitrate ?? 0),
  )[0];
};

const getAudioByUrl = (videoUrl) => {
  const videoId = new URL(videoUrl).searchParams.get("v");
  if (!videoId) throw new Error("Invalid YouTube URL");

  const key = `audio:${videoId}`;
  const cached = audioCache.get(key);
  if (cached) {
    console.log(`🟢 AUDIO HIT: ${videoId}`);
    return Promise.resolve(cached);
  }

  console.log(`🟡 AUDIO MISS: ${videoId}`);

  return withDedup(pendingAudio, key, async () => {
    const start = now();
    const yt = app.locals.yt;

    // TV_EMBEDDED: không trả ads/companion → parser không crash
    // ANDROID: fallback nếu TV_EMBEDDED bị block (hiếm)
    const clients = ["ANDROID", "TV_EMBEDDED"];
    let info = null;

    for (const client of clients) {
      try {
        info = await yt.getInfo(videoId, { client });
        if (info?.streaming_data) break;
        console.warn(`⚠️ ${client} no streaming_data for ${videoId}`);
        info = null;
      } catch (err) {
        console.warn(`⚠️ ${client} failed for ${videoId}: ${err.message}`);
      }
    }

    if (!info?.streaming_data)
      throw new Error(`No streaming data for ${videoId}`);

    const fmt = pickBestAudioFormat(info);
    if (!fmt?.url) throw new Error("No audio format found");

    logTime(`audio url "${videoId}"`, start);

    const audio = {
      url: fmt.url,
      duration: info.basic_info.duration ?? 0,
      mimeType: fmt.mime_type?.split(";")[0] ?? "audio/webm",
      bitrate: fmt.average_bitrate ?? fmt.bitrate ?? null,
      expireAt: Date.now() + AUDIO_CACHE_TTL * 1000,
    };

    audioCache.set(key, audio);
    return audio;
  });
};

const searchAndGetAudio = (query) =>
  withDedup(pendingCombo, `combo:${query.toLowerCase().trim()}`, async () => {
    const start = now();

    const candidates = await searchYouTube(query);
    if (!candidates.length) throw new Error("No results found");

    let lastErr;
    for (const v of candidates.slice(0, RACE_TOP_N)) {
      try {
        const audio = await getAudioByUrl(v.url);
        logTime(`combo TOTAL "${query}"`, start);
        return { video: v, audio: { ...audio, url: `/music/stream/${v.id}` } };
      } catch (err) {
        console.warn(`⚠️ audio failed for ${v.url.slice(-11)}: ${err.message}`);
        lastErr = err;
      }
    }

    throw lastErr ?? new Error("All candidates failed");
  });

// ─────────────────────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.json({ status: "ok", service: "music-backend" }));

// POST /music/audio
app.post("/music/audio", async (req, res) => {
  const start = now();
  try {
    const query = String(req.body.query || "").trim();
    const url = String(req.body.url || "").trim();

    if (!query && !url) {
      return res.status(400).json({ message: "Missing query or url" });
    }

    if (url) {
      const videoId = new URL(url).searchParams.get("v");
      const audio = await getAudioByUrl(url);
      logTime("POST /music/audio (url)", start);
      return res.json({ audio: { ...audio, url: `/music/stream/${videoId}` } });
    }

    const data = await searchAndGetAudio(query);
    logTime("POST /music/audio TOTAL", start);
    return res.json(data);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ message: err.message });
  }
});

// GET /music/stream/:videoId — proxy stream về client
app.get("/music/stream/:videoId", async (req, res) => {
  try {
    const { videoId } = req.params;

    if (req.query.bust) audioCache.del(`audio:${videoId}`);

    const audio = await getAudioByUrl(
      `https://www.youtube.com/watch?v=${videoId}`,
    );

    const upstreamHeaders = {
      "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/",
      Accept: "*/*",
      "Accept-Encoding": "identity",
    };

    if (req.headers.range) upstreamHeaders["Range"] = req.headers.range;

    let upstream = await fetch(audio.url, { headers: upstreamHeaders });

    if (upstream.status === 403) {
      console.warn(`⚠️ 403 for ${videoId}, busting cache and retrying...`);
      audioCache.del(`audio:${videoId}`);
      const fresh = await getAudioByUrl(
        `https://www.youtube.com/watch?v=${videoId}`,
      );
      upstream = await fetch(fresh.url, { headers: upstreamHeaders });
    }

    if (!upstream.ok && upstream.status !== 206) {
      return res
        .status(upstream.status)
        .json({ message: `Upstream error: ${upstream.status}` });
    }

    return pipeStream(upstream, res, audio.mimeType);
  } catch (err) {
    console.error("stream error:", err.message);
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});

const pipeStream = (upstream, res, mimeType) => {
  res.status(upstream.status);
  res.setHeader("Content-Type", mimeType ?? "audio/webm");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const cl = upstream.headers.get("content-length");
  const cr = upstream.headers.get("content-range");
  if (cl) res.setHeader("Content-Length", cl);
  if (cr) res.setHeader("Content-Range", cr);

  return upstream.body.pipeTo(
    new WritableStream({
      write(chunk) {
        res.write(chunk);
      },
      close() {
        res.end();
      },
      abort(err) {
        res.destroy(err);
      },
    }),
  );
};

// GET /music/cache — clear all caches
app.get("/music/cache", (req, res) => {
  searchCache.flushAll();
  audioCache.flushAll();
  pendingSearch.clear();
  pendingAudio.clear();
  pendingCombo.clear();
  console.log("🗑️ All caches cleared");
  res.json({ message: "Cache cleared" });
});

// ─────────────────────────────────────────────────────────────
// INIT — TV_EMBEDDED không cần retrieve_player
// ─────────────────────────────────────────────────────────────

Innertube.create({
  cache: null,
  generate_session_locally: true,
  retrieve_player: false, // TV_EMBEDDED tự handle, không cần player JS
}).then((yt) => {
  app.locals.yt = yt;
  app.listen(PORT, "0.0.0.0", () =>
    console.log(`🚀 Server running on port ${PORT}`),
  );
});
