const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const NodeCache = require("node-cache");
const youtubedl = require("youtube-dl-exec");
const ytSearch = require("yt-search");

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

const AUDIO_FORMAT = process.env.YT_AUDIO_FORMAT || "140";

const DEFAULT_USER_AGENT =
  process.env.YT_DLP_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const STREAM_CACHE_TTL = 60 * 60 * 4; // 4h
const SEARCH_CACHE_TTL = 60 * 60; // 1h
const DISK_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h

const PREFETCH_CONCURRENCY = 8;
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_WARM_COUNT = 5;

// ─────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────

const streamCache = new NodeCache({
  stdTTL: STREAM_CACHE_TTL,
  checkperiod: 120,
  useClones: false,
});

const searchCache = new NodeCache({
  stdTTL: SEARCH_CACHE_TTL,
  checkperiod: 120,
  useClones: false,
});

const CACHE_DIR = path.join(__dirname, "cache", "streams");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const pendingStreams = new Map();
const pendingSearches = new Map();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const normalizeVideoUrl = (input) => {
  if (!input) return null;

  const str = String(input).trim();

  if (str.includes("youtube.com/watch")) {
    return str;
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    return `https://www.youtube.com/watch?v=${str}`;
  }

  return null;
};

const cacheFileName = (videoUrl) =>
  Buffer.from(videoUrl).toString("base64url") + ".json";

const cacheFilePath = (videoUrl) =>
  path.join(CACHE_DIR, cacheFileName(videoUrl));

const readDiskCache = (videoUrl) => {
  try {
    const file = cacheFilePath(videoUrl);

    if (!fs.existsSync(file)) return null;

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));

    if (!raw?.storedAt || !raw?.payload) {
      return null;
    }

    const expired =
      Date.now() - raw.storedAt > (raw.ttlMs || DISK_CACHE_TTL_MS);

    if (expired) {
      fs.unlinkSync(file);
      return null;
    }

    return raw.payload;
  } catch {
    return null;
  }
};

const writeDiskCache = (videoUrl, payload) => {
  try {
    const file = cacheFilePath(videoUrl);

    fs.writeFileSync(
      file,
      JSON.stringify({
        storedAt: Date.now(),
        ttlMs: DISK_CACHE_TTL_MS,
        payload,
      }),
      "utf8",
    );
  } catch {}
};

// ─────────────────────────────────────────────────────────────
// YT-DLP
// ─────────────────────────────────────────────────────────────

const createYtDlpOptions = () => ({
  getUrl: true,
  format: AUDIO_FORMAT,

  forceIpv4: true,
  noPlaylist: true,
  noWarnings: true,
  noCheckCertificates: true,

  socketTimeout: 15,

  extractorArgs: "youtube:player_client=android",

  addHeader: [`referer:youtube.com`, `user-agent:${DEFAULT_USER_AGENT}`],
});

const fetchStream = async (videoUrl) => {
  const start = Date.now();

  const result = await youtubedl(videoUrl, createYtDlpOptions());

  const streamUrl = String(result || "").trim();

  if (!streamUrl) {
    throw new Error("Empty stream URL");
  }

  console.log(`[yt-dlp] resolved ${videoUrl} in ${Date.now() - start}ms`);

  return {
    streamUrl,
    videoUrl,
    cachedAt: Date.now(),
    expiresAt: Date.now() + STREAM_CACHE_TTL * 1000,
  };
};

const warmupYtDlp = async () => {
  try {
    console.log("[yt-dlp] warmup started");

    await youtubedl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
    });

    console.log("[yt-dlp] warmup complete");
  } catch (err) {
    console.warn("[yt-dlp] warmup failed:", err?.message);
  }
};

// ─────────────────────────────────────────────────────────────
// STREAM CACHE
// ─────────────────────────────────────────────────────────────

const getOrFetchStream = async (videoUrl) => {
  const key = `stream:${videoUrl}`;

  if (pendingStreams.has(key)) {
    return pendingStreams.get(key);
  }

  const memoryHit = streamCache.get(key);

  if (memoryHit) {
    return memoryHit;
  }

  const diskHit = readDiskCache(videoUrl);

  if (diskHit) {
    streamCache.set(key, diskHit);
    return diskHit;
  }

  const promise = fetchStream(videoUrl)
    .then((payload) => {
      streamCache.set(key, payload);
      writeDiskCache(videoUrl, payload);
      return payload;
    })
    .finally(() => {
      pendingStreams.delete(key);
    });

  pendingStreams.set(key, promise);

  return promise;
};

// ─────────────────────────────────────────────────────────────
// PREFETCH
// ─────────────────────────────────────────────────────────────

const prefetchQueue = [];
let prefetchActive = 0;

const processPrefetchQueue = () => {
  while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length) {
    const item = prefetchQueue.shift();

    prefetchActive++;

    getOrFetchStream(item.videoUrl)
      .then(() => {
        console.log(`[prefetch:${item.label}] ✓ ${item.videoUrl}`);
      })
      .catch((err) => {
        console.warn(
          `[prefetch:${item.label}] ✗ ${item.videoUrl}`,
          err?.stderr || err?.message || err,
        );
      })
      .finally(() => {
        prefetchActive--;
        setImmediate(processPrefetchQueue);
      });
  }
};

const enqueuePrefetch = (videoUrl, label = "prefetch") => {
  if (!videoUrl) return;

  const exists = prefetchQueue.find((item) => item.videoUrl === videoUrl);

  if (exists) return;

  prefetchQueue.push({
    videoUrl,
    label,
  });

  processPrefetchQueue();
};

// ─────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────

const searchYouTube = async (query) => {
  const normalized = query.toLowerCase().trim();
  const cacheKey = `search:${normalized}`;

  const cached = searchCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  if (pendingSearches.has(cacheKey)) {
    return pendingSearches.get(cacheKey);
  }

  const promise = (async () => {
    const result = await ytSearch(query);

    const videos = (result.videos || [])
      .filter((v) => !v.title.toLowerCase().includes("karaoke"))
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((v) => ({
        id: v.videoId,
        title: v.title,
        duration: v.timestamp,
        thumbnail: v.thumbnail,
        channel: v.author?.name || null,
      }));

    searchCache.set(cacheKey, videos);

    for (const item of videos.slice(0, SEARCH_WARM_COUNT)) {
      enqueuePrefetch(
        `https://www.youtube.com/watch?v=${item.id}`,
        "search-warm",
      );
    }

    return videos;
  })().finally(() => {
    pendingSearches.delete(cacheKey);
  });

  pendingSearches.set(cacheKey, promise);

  return promise;
};

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

app.get("/", (_, res) => {
  res.send("Music backend running");
});

// Search only
app.get("/music/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        message: "Missing query",
      });
    }

    const results = await searchYouTube(query);

    return res.json(results);
  } catch (err) {
    return res.status(500).json({
      message: err?.message || "Search failed",
    });
  }
});

// Direct ultra-fast cache endpoint
app.get("/music/direct/:videoId", async (req, res) => {
  try {
    const videoUrl = normalizeVideoUrl(req.params.videoId);

    if (!videoUrl) {
      return res.status(400).json({
        message: "Invalid videoId",
      });
    }

    const cacheKey = `stream:${videoUrl}`;

    const cached = streamCache.get(cacheKey) || readDiskCache(videoUrl);

    if (!cached) {
      return res.status(404).json({
        message: "Cache miss",
      });
    }

    return res.json(cached);
  } catch (err) {
    return res.status(500).json({
      message: "Failed",
    });
  }
});

// Resolve stream
app.get("/music/stream/:videoId", async (req, res) => {
  const start = Date.now();

  try {
    const videoUrl = normalizeVideoUrl(req.params.videoId);

    if (!videoUrl) {
      return res.status(400).json({
        message: "Invalid videoId",
      });
    }

    const result = await getOrFetchStream(videoUrl);

    console.log(`[stream] resolved in ${Date.now() - start}ms`);

    return res.json({
      streamUrl: result.streamUrl,
      videoId: req.params.videoId,
      cachedAt: result.cachedAt,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    console.warn("[stream] failed:", err?.stderr || err?.message || err);

    return res.status(404).json({
      message: "No playable stream found",
    });
  }
});

// Search + stream
app.post("/music/stream-best", async (req, res) => {
  const start = Date.now();

  try {
    const query = String(req.body?.query || "").trim();

    if (!query) {
      return res.status(400).json({
        message: "Missing query",
      });
    }

    const results = await searchYouTube(query);

    if (!results.length) {
      return res.status(404).json({
        message: "No results",
      });
    }

    const candidates = results.slice(0, 3);

    const winner = await Promise.any(
      candidates.map(async (item) => {
        const videoUrl = `https://www.youtube.com/watch?v=${item.id}`;

        const result = await getOrFetchStream(videoUrl);

        return {
          streamUrl: result.streamUrl,
          videoId: item.id,
          title: item.title,
        };
      }),
    );

    console.log(`[stream-best] "${query}" resolved in ${Date.now() - start}ms`);

    return res.json(winner);
  } catch (err) {
    console.warn("[stream-best] failed:", err?.stderr || err?.message || err);

    return res.status(404).json({
      message: "No playable stream found",
    });
  }
});

// Manual prefetch
app.post("/music/prefetch", async (req, res) => {
  try {
    const videoUrls = Array.isArray(req.body?.videoUrls)
      ? req.body.videoUrls
      : [];

    let queued = 0;

    for (const input of videoUrls.slice(0, 50)) {
      const videoUrl = normalizeVideoUrl(input);

      if (!videoUrl) continue;

      enqueuePrefetch(videoUrl, "manual");

      queued++;
    }

    return res.json({
      queued,
    });
  } catch {
    return res.status(400).json({
      message: "Invalid request",
    });
  }
});

// Health
app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache: {
      stream: streamCache.keys().length,
      search: searchCache.keys().length,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  warmupYtDlp();
});
