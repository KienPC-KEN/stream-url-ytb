const express = require("express");
const cors = require("cors");
const youtubedl = require("youtube-dl-exec").create("yt-dlp");
const yts = require("youtube-search-api");
const NodeCache = require("node-cache");

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const STREAM_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh khi còn 5 phút

const AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio";

const YT_DLP_FLAGS = {
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  socketTimeout: 5,
  extractorArgs: "youtube:skip=dash,hls",
};

// ─── Cache & dedup ────────────────────────────────────────────────────────────

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const searchCache = new NodeCache({ stdTTL: 600 });

const pendingStreams = new Map();
const pendingSearches = new Map();

// ─── yt-dlp helpers ───────────────────────────────────────────────────────────

/**
 * Lấy stream URL + duration trong 1 process duy nhất via --print.
 * Nhanh hơn dump-single-json vì không parse toàn bộ metadata.
 */
const fetchStream = async (videoUrl) => {
  const result = await youtubedl.exec(videoUrl, {
    ...YT_DLP_FLAGS,
    print: ["url", "duration"],
    format: AUDIO_FORMAT,
  });

  const stdout =
    typeof result === "string" ? result : String(result?.stdout ?? "");

  const lines = stdout
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);

  const streamUrl = lines[0];
  const duration = Number(lines[1]) || null;

  // const [rawUrl, rawDuration] = stdout.trim().split("\n");
  // const streamUrl = rawUrl?.trim() ?? "";

  if (!streamUrl) throw new Error("yt-dlp returned empty stream URL");

  return {
    streamUrl,
    duration: parseFloat(duration) || null,
  };
};

// ─── Cache utilities ──────────────────────────────────────────────────────────

const getRemainingTtlMs = (cache, key) => {
  const ttl = cache.getTtl(key);
  return ttl ? ttl - Date.now() : Infinity;
};

/**
 * Fetch + cache stream, dedup concurrent calls bằng pending map.
 * Nếu đã có pending promise (từ prefetch), reuse thay vì spawn mới.
 */
const getOrFetchStream = (videoUrl) => {
  const key = `stream:${videoUrl}`;

  // Đang fetch → reuse
  if (pendingStreams.has(key)) return pendingStreams.get(key);

  const promise = fetchStream(videoUrl)
    .then((payload) => {
      streamCache.set(key, payload);
      return payload;
    })
    .finally(() => pendingStreams.delete(key));

  pendingStreams.set(key, promise);
  return promise;
};

/**
 * Fire-and-forget: fetch stream ngầm, không block caller.
 * Dùng cho cả prefetch sau search lẫn proactive refresh trước khi hết TTL.
 */
const fetchStreamSilently = (videoUrl, label = "bg") => {
  const key = `stream:${videoUrl}`;
  if (streamCache.has(key) || pendingStreams.has(key)) return; // đã có rồi

  getOrFetchStream(videoUrl)
    .then(() => console.log(`[stream:${label}] ✓ ${videoUrl}`))
    .catch((err) =>
      console.warn(`[stream:${label}] ✗ ${videoUrl}:`, err.message),
    );
};

/**
 * Proactive refresh khi cache sắp hết TTL (non-blocking).
 */
const refreshStreamSilently = (videoUrl) => {
  const key = `stream:${videoUrl}`;
  if (pendingStreams.has(key)) return;

  getOrFetchStream(videoUrl).catch((err) =>
    console.warn(`[stream:refresh] ✗ ${videoUrl}:`, err.message),
  );
};

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ─── GET /music/search?keyword= ───────────────────────────────────────────────

app.get("/music/search", async (req, res) => {
  const keyword = String(req.query.keyword ?? "").trim();
  if (!keyword) return res.status(400).json({ message: "Missing keyword" });

  const key = `search:${keyword.toLowerCase()}`;

  // Cache hit
  const cached = searchCache.get(key);
  if (cached) {
    console.log(`[search] cache hit: "${keyword}"`);
    // Prefetch lại nếu stream cache đã expire (server restart, TTL ngắn hơn)
    const firstId = cached[0]?.id;
    if (firstId)
      fetchStreamSilently(
        `https://www.youtube.com/watch?v=${firstId}`,
        "prefetch",
      );
    return res.json(cached);
  }

  // Dedup
  if (pendingSearches.has(key)) return res.json(await pendingSearches.get(key));

  const promise = (async () => {
    const result = await yts.GetListByKeyword(keyword, true, 15);

    const items = [];

    for (const item of result.items ?? []) {
      const title = String(item.title ?? "").toLowerCase();

      // Skip karaoke
      if (title.includes("karaoke")) continue;

      const durationText = item.length?.simpleText ?? "";
      const parts = durationText.split(":");

      let totalSeconds = 0;

      if (parts.length === 2) {
        totalSeconds = Number(parts[0]) * 60 + Number(parts[1]);
      } else if (parts.length === 3) {
        totalSeconds =
          Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
      }

      // > 8 phút
      if (totalSeconds > 480) continue;

      items.push({
        id: item.id,
        title: item.title,
        thumbnail:
          item.thumbnail?.thumbnails?.[0]?.url ?? item.thumbnail?.url ?? null,
        channel: item.channelTitle ?? null,
        duration: durationText || null,
      });
    }

    searchCache.set(key, items);

    // Prefetch stream ngầm cho item duy nhất — không block response
    // Khi user bấm play, stream đã sẵn sàng trong cache → ~0ms
    const firstId = items[0]?.id;
    if (firstId) {
      const videoUrl = `https://www.youtube.com/watch?v=${firstId}`;
      fetchStreamSilently(videoUrl, "prefetch");
    }

    return items;
  })()
    .catch((err) => {
      console.error("[search] error:", err.message);
      throw err;
    })
    .finally(() => pendingSearches.delete(key));

  pendingSearches.set(key, promise);

  try {
    return res.json(await promise);
  } catch {
    return res.status(500).json({ message: "Search failed" });
  }
});

// ─── GET /music/stream?url= ───────────────────────────────────────────────────

app.get("/music/stream", async (req, res) => {
  const start = Date.now();
  const videoUrl = String(req.query.url ?? "").trim();
  if (!videoUrl) return res.status(400).json({ message: "Missing url" });

  const key = `stream:${videoUrl}`;
  const elapsed = () => `${Date.now() - start}ms`;

  try {
    // Cache hit
    const cached = streamCache.get(key);
    if (cached) {
      // Proactive refresh nếu gần hết TTL
      if (getRemainingTtlMs(streamCache, key) < STREAM_REFRESH_THRESHOLD_MS) {
        console.log(`[stream] proactive refresh: ${videoUrl}`);
        refreshStreamSilently(videoUrl);
      }
      console.log(`[stream] cache hit (${elapsed()})`);
      return res.json({ ...cached, executionTime: elapsed() });
    }

    // Pending hoặc cold fetch — getOrFetchStream dedup tự động
    const payload = await getOrFetchStream(videoUrl);
    console.log(`[stream] fetched (${elapsed()})`);
    return res.json({ ...payload, executionTime: elapsed() });
  } catch (err) {
    console.error("[stream] error:", err.message);
    return res.status(500).json({ message: "Get stream failed" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
