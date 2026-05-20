const express = require("express");
const cors = require("cors");
const NodeCache = require("node-cache");
const yts = require("youtube-search-api");
const youtubedl = require("youtube-dl-exec").create("yt-dlp");

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const STREAM_TTL = 3600;
const SEARCH_TTL = 600;

const STREAM_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

const AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio";

const BLOCKED_REGEX = /karaoke/i;

const YT_DLP_FLAGS = {
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  socketTimeout: 5,
  extractorArgs: "youtube:skip=dash,hls",
};

// ─────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────

const streamCache = new NodeCache({
  stdTTL: STREAM_TTL,
  checkperiod: 120,
});

const searchCache = new NodeCache({
  stdTTL: SEARCH_TTL,
});

const pendingStreams = new Map();
const pendingSearches = new Map();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const parseDurationToSeconds = (durationText = "") => {
  const parts = durationText.split(":").map(Number);

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return 0;
};

const isValidMusicItem = (item) => {
  const title = String(item.title ?? "");

  if (BLOCKED_REGEX.test(title)) {
    return false;
  }

  const durationText = item.length?.simpleText ?? "";

  const totalSeconds = parseDurationToSeconds(durationText);

  return totalSeconds <= 480; // Lọc video dài hơn 8 phút
};

const mapSearchItem = (item) => ({
  id: item.id,
  title: item.title,
  thumbnail:
    item.thumbnail?.thumbnails?.[0]?.url ?? item.thumbnail?.url ?? null,
  channel: item.channelTitle ?? null,
  duration: item.length?.simpleText ?? null,
});

const getRemainingTtlMs = (cache, key) => {
  const ttl = cache.getTtl(key);
  return ttl ? ttl - Date.now() : Infinity;
};

// ─────────────────────────────────────────────────────────────
// yt-dlp
// ─────────────────────────────────────────────────────────────

const fetchStream = async (videoUrl) => {
  const result = await youtubedl.exec(videoUrl, {
    ...YT_DLP_FLAGS,
    format: AUDIO_FORMAT,
    print: "url\nduration",
  });

  const stdout =
    typeof result === "string" ? result : String(result?.stdout ?? "");

  const [rawUrl, rawDuration] = stdout.trim().split("\n");

  const streamUrl = rawUrl?.trim();

  if (!streamUrl) {
    throw new Error("yt-dlp returned empty stream URL");
  }

  return {
    streamUrl,
    duration: Number(rawDuration) || null,
  };
};

// ─────────────────────────────────────────────────────────────
// Stream cache
// ─────────────────────────────────────────────────────────────

const getOrFetchStream = (videoUrl) => {
  const key = `stream:${videoUrl}`;

  const cached = streamCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = pendingStreams.get(key);
  if (pending) return pending;

  const promise = fetchStream(videoUrl)
    .then((payload) => {
      streamCache.set(key, payload);
      return payload;
    })
    .finally(() => {
      pendingStreams.delete(key);
    });

  pendingStreams.set(key, promise);

  return promise;
};

const fetchStreamSilently = async (videoUrl, label = "bg") => {
  try {
    await getOrFetchStream(videoUrl);

    console.log(`[stream:${label}] ✓ ${videoUrl}`);
  } catch (err) {
    console.warn(`[stream:${label}] ✗ ${videoUrl}:`, err.message);
  }
};

const refreshStreamSilently = (videoUrl) => {
  const key = `stream:${videoUrl}`;

  if (pendingStreams.has(key)) {
    return;
  }

  fetchStreamSilently(videoUrl, "refresh");
};

// ─────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────

const searchMusic = async (keyword) => {
  const result = await yts.GetListByKeyword(keyword, false, 1);

  const items = [];

  for (const item of result.items ?? []) {
    if (!isValidMusicItem(item)) {
      continue;
    }

    items.push(mapSearchItem(item));

    // Limit kết quả để response nhanh hơn
    if (items.length >= 20) {
      break;
    }
  }

  return items;
};

// ─────────────────────────────────────────────────────────────
// Express
// ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// GET /music/search
// ─────────────────────────────────────────────────────────────

app.get("/music/search", async (req, res) => {
  try {
    const keyword = String(req.query.keyword ?? "").trim();

    if (!keyword) {
      return res.status(400).json({
        message: "Missing keyword",
      });
    }

    const key = `search:${keyword.toLowerCase()}`;

    // Cache hit
    const cached = searchCache.get(key);

    if (cached) {
      console.log(`[search] cache hit: "${keyword}"`);

      const firstId = cached[0]?.id;

      if (firstId) {
        fetchStreamSilently(
          `https://www.youtube.com/watch?v=${firstId}`,
          "prefetch",
        );
      }

      return res.json(cached);
    }

    // Dedup
    if (pendingSearches.has(key)) {
      return res.json(await pendingSearches.get(key));
    }

    const promise = searchMusic(keyword)
      .then((items) => {
        searchCache.set(key, items);

        const firstId = items[0]?.id;

        if (firstId) {
          fetchStreamSilently(
            `https://www.youtube.com/watch?v=${firstId}`,
            "prefetch",
          );
        }

        return items;
      })
      .finally(() => {
        pendingSearches.delete(key);
      });

    pendingSearches.set(key, promise);

    return res.json(await promise);
  } catch (err) {
    console.error("[search] error:", err.message);

    return res.status(500).json({
      message: "Search failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /music/stream
// ─────────────────────────────────────────────────────────────

app.get("/music/stream", async (req, res) => {
  const start = Date.now();

  try {
    const videoUrl = String(req.query.url ?? "").trim();

    if (!videoUrl) {
      return res.status(400).json({
        message: "Missing url",
      });
    }

    const key = `stream:${videoUrl}`;

    const cached = streamCache.get(key);

    if (cached) {
      if (getRemainingTtlMs(streamCache, key) < STREAM_REFRESH_THRESHOLD_MS) {
        refreshStreamSilently(videoUrl);
      }

      return res.json({
        ...cached,
        executionTime: `${Date.now() - start}ms`,
      });
    }

    const payload = await getOrFetchStream(videoUrl);

    return res.json({
      ...payload,
      executionTime: `${Date.now() - start}ms`,
    });
  } catch (err) {
    console.error("[stream] error:", err.message);

    return res.status(500).json({
      message: "Get stream failed",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
