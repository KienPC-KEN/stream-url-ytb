const express = require("express");
const cors = require("cors");
const youtubedl = require("youtube-dl-exec");
const yts = require("youtube-search-api");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const AUDIO_FORMAT =
  process.env.YT_DLP_FORMAT || "139/140/bestaudio[ext=m4a]/bestaudio";

const DEFAULT_USER_AGENT =
  process.env.YT_DLP_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const YT_DLP_FLAGS = {
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  socketTimeout: 5,
  addHeader: [`referer:youtube.com`, `user-agent:${DEFAULT_USER_AGENT}`],
};

// ─── Cache & dedup ────────────────────────────────────────────────────────────

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const searchCache = new NodeCache({ stdTTL: 600 });

const PERSIST_CACHE_DIR = path.join(__dirname, "cache", "streams");
const PERSIST_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

if (!fs.existsSync(PERSIST_CACHE_DIR)) {
  try {
    fs.mkdirSync(PERSIST_CACHE_DIR, { recursive: true });
  } catch (e) {
    console.warn("Failed to create persist cache dir:", e?.message ?? e);
  }
}

const videoUrlToFilename = (videoUrl) => {
  try {
    return Buffer.from(videoUrl).toString("base64").replace(/=/g, "");
  } catch (e) {
    return encodeURIComponent(videoUrl).replace(/[^a-zA-Z0-9-_\.]/g, "_");
  }
};

const readDiskCache = (videoUrl) => {
  const fname = path.join(
    PERSIST_CACHE_DIR,
    videoUrlToFilename(videoUrl) + ".json",
  );
  try {
    if (!fs.existsSync(fname)) return null;
    const raw = fs.readFileSync(fname, "utf8");
    const obj = JSON.parse(raw);
    if (!obj?.storedAt) return null;
    if (Date.now() - obj.storedAt > (obj.ttlMs ?? PERSIST_TTL_MS)) {
      try {
        fs.unlinkSync(fname);
      } catch (e) {}
      return null;
    }
    return obj.payload ?? null;
  } catch (e) {
    return null;
  }
};

const writeDiskCache = (videoUrl, payload, ttlMs = PERSIST_TTL_MS) => {
  const fname = path.join(
    PERSIST_CACHE_DIR,
    videoUrlToFilename(videoUrl) + ".json",
  );
  try {
    fs.writeFileSync(
      fname,
      JSON.stringify({ storedAt: Date.now(), ttlMs, payload }),
      { encoding: "utf8" },
    );
  } catch (e) {
    // ignore write failures
  }
};

const pendingStreams = new Map();
const pendingSearches = new Map();

// ─── yt-dlp helpers ───────────────────────────────────────────────────────────

const fetchStream = async (videoUrl) => {
  const info = await youtubedl(videoUrl, {
    getUrl: true,
    format: AUDIO_FORMAT,
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    forceIpv4: true,
    addHeader: [`referer:youtube.com`, `user-agent:${DEFAULT_USER_AGENT}`],
  });

  const streamUrl = String(info).trim();

  if (!streamUrl) {
    throw new Error("Empty stream URL");
  }

  return { streamUrl };
};

// ─── Cache utilities ──────────────────────────────────────────────────────────

const getOrFetchStream = (videoUrl) => {
  const key = `stream:${videoUrl}`;

  if (pendingStreams.has(key)) {
    console.log(`[stream-cache] pending reuse: ${videoUrl}`);
    return pendingStreams.get(key);
  }

  const mem = streamCache.get(key);
  if (mem) {
    console.log(`[stream-cache] memory hit: ${videoUrl}`);
    return Promise.resolve(mem);
  }

  try {
    const disk = readDiskCache(videoUrl);
    if (disk) {
      console.log(`[stream-cache] disk hit: ${videoUrl}`);
      streamCache.set(key, disk);
      return Promise.resolve(disk);
    }
  } catch (e) {
    // ignore
  }

  const promise = fetchStream(videoUrl)
    .then((payload) => {
      streamCache.set(key, payload);
      try {
        writeDiskCache(videoUrl, payload);
      } catch (e) {}
      return payload;
    })
    .finally(() => pendingStreams.delete(key));

  pendingStreams.set(key, promise);
  return promise;
};

// ─── Prefetch queue ───────────────────────────────────────────────────────────

const PREFETCH_CONCURRENCY = 3;
const prefetchQueue = [];
let prefetchActive = 0;

const processPrefetchQueue = () => {
  while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const item = prefetchQueue.shift();
    prefetchActive++;
    getOrFetchStream(item.videoUrl)
      .then(() => console.log(`[stream:${item.label}] ✓ ${item.videoUrl}`))
      .catch((err) =>
        console.warn(`[stream:${item.label}] ✗ ${item.videoUrl}:`, err.message),
      )
      .finally(() => {
        prefetchActive--;
        setImmediate(processPrefetchQueue);
      });
  }
};

const enqueuePrefetch = (videoUrl, label = "prefetch") => {
  if (prefetchQueue.find((q) => q.videoUrl === videoUrl)) return;
  prefetchQueue.push({ videoUrl, label });
  processPrefetchQueue();
};

// ─── Search helpers ───────────────────────────────────────────────────────────

const searchYouTube = async (query) => {
  const searchKey = `search:${query.toLowerCase()}`;

  const cached = searchCache.get(searchKey);
  if (cached) return cached;

  const pending = pendingSearches.get(searchKey);
  if (pending) return pending;

  const promise = (async () => {
    const response = await yts.GetListByKeyword(query, true, 8);
    const items = (response.items ?? [])
      .slice(0, 8)
      .filter(
        (item) =>
          !String(item.title ?? "")
            .toLowerCase()
            .includes("karaoke"),
      )
      .map((item) => ({
        id: item.id,
        title: item.title,
        thumbnail: item.thumbnail?.thumbnails?.[0]?.url ?? null,
        channel: item.channelTitle ?? null,
        duration: item.length?.simpleText ?? null,
      }))
      .slice(0, 5);

    searchCache.set(searchKey, items);

    // Warm cache for top results
    for (const item of items.slice(0, 3)) {
      if (item?.id) {
        enqueuePrefetch(
          `https://www.youtube.com/watch?v=${item.id}`,
          "search-warm",
        );
      }
    }

    return items;
  })().finally(() => pendingSearches.delete(searchKey));

  pendingSearches.set(searchKey, promise);
  return promise;
};

const collectStreamCandidateIds = async (query, providedIds = []) => {
  const uniqueIds = [];
  const seen = new Set();

  for (const id of providedIds) {
    const normalized = String(id ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueIds.push(normalized);
    if (uniqueIds.length >= 5) return uniqueIds;
  }

  if (query) {
    const results = await searchYouTube(query);
    for (const item of results ?? []) {
      const normalized = String(item?.id ?? "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      uniqueIds.push(normalized);
      if (uniqueIds.length >= 5) break;
    }
  }

  return uniqueIds;
};

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// POST /music/prefetch
app.post("/music/prefetch", (req, res) => {
  try {
    const urls = Array.isArray(req.body?.videoUrls) ? req.body.videoUrls : [];
    for (const u of urls.slice(0, 50)) {
      if (typeof u === "string" && u.trim())
        enqueuePrefetch(u.trim(), "prefetch-api");
    }
    return res.json({ queued: urls.length });
  } catch (e) {
    return res.status(400).json({ message: "Invalid request" });
  }
});

// GET /music/stream/:videoId — bypass search, direct stream by known videoId
app.get("/music/stream/:videoId", async (req, res) => {
  const { videoId } = req.params;
  if (!videoId) return res.status(400).json({ message: "Missing videoId" });

  const start = Date.now();

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const { streamUrl } = await getOrFetchStream(videoUrl);

    console.log(
      `[stream] resolved videoId="${videoId}" in ${Date.now() - start}ms`,
    );

    return res.json({ streamUrl, videoId });
  } catch (err) {
    console.warn(`[stream] failed videoId="${videoId}":`, err?.message);
    return res.status(404).json({ message: "Stream not found" });
  }
});

// POST /music/stream-best — search + resolve best stream
app.post("/music/stream-best", async (req, res) => {
  const start = Date.now();

  try {
    const query = String(req.body?.query ?? "").trim();

    if (!query) {
      return res.status(400).json({ message: "Missing query" });
    }

    const videoIds = await collectStreamCandidateIds(query);

    if (!videoIds.length) {
      return res.status(404).json({ message: "No candidates found" });
    }

    // Race top 5, return first winner
    const results = await Promise.any(
      videoIds.slice(0, 5).map(async (id) => {
        const videoUrl = `https://www.youtube.com/watch?v=${id}`;
        const { streamUrl } = await getOrFetchStream(videoUrl);
        return { streamUrl, videoId: id };
      }),
    );

    console.log(`[stream-best] resolved "${query}" in ${Date.now() - start}ms`);

    return res.json({
      streamUrl: results.streamUrl,
      videoId: results.videoId, // return videoId for client to cache
    });
  } catch (err) {
    console.warn(`[stream-best] failed "${req.body?.query}":`, err?.message);
    return res.status(404).json({ message: "No playable stream found" });
  }
});

app.get("/", (_, res) => {
  res.send("Music backend running");
});
// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
