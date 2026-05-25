const express = require("express");
const cors = require("cors");
const youtubedl = require("youtube-dl-exec").create("yt-dlp");
const yts = require("youtube-search-api");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const STREAM_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh khi còn 5 phút

const AUDIO_FORMAT =
  process.env.YT_DLP_FORMAT || "139/140/bestaudio[ext=m4a]/bestaudio";

const buildYtDlpFlags = (extraFlags = {}) => ({
  ...extraFlags,
});

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

const YT_DLP_FALLBACK_FLAGS = {
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  socketTimeout: 5,
  addHeader: [`referer:youtube.com`, `user-agent:${DEFAULT_USER_AGENT}`],
};

const isVideoUnavailableError = (error) =>
  /this video is not available|video unavailable|is not available/i.test(
    String(error?.message ?? error?.stderr ?? ""),
  );

const chooseBestAudioFormat = (info) => {
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  const audioOnly = formats.filter(
    (format) =>
      format?.url &&
      format?.acodec &&
      format.acodec !== "none" &&
      (!format?.vcodec || format.vcodec === "none"),
  );

  const candidates =
    audioOnly.length > 0 ? audioOnly : formats.filter((format) => format?.url);

  const preferredExtOrder = new Map([
    ["m4a", 0],
    ["mp4", 1],
    ["aac", 2],
    ["webm", 3],
    ["3gp", 4],
  ]);

  return candidates.slice().sort((left, right) => {
    const leftExtScore = preferredExtOrder.has(left?.ext)
      ? preferredExtOrder.get(left.ext)
      : 99;
    const rightExtScore = preferredExtOrder.has(right?.ext)
      ? preferredExtOrder.get(right.ext)
      : 99;

    if (leftExtScore !== rightExtScore) {
      return leftExtScore - rightExtScore;
    }

    const leftAbr = Number(left?.abr ?? Number.POSITIVE_INFINITY);
    const rightAbr = Number(right?.abr ?? Number.POSITIVE_INFINITY);

    if (leftAbr !== rightAbr) {
      return leftAbr - rightAbr;
    }

    const leftSize = Number(
      left?.filesize ?? left?.filesize_approx ?? Number.POSITIVE_INFINITY,
    );
    const rightSize = Number(
      right?.filesize ?? right?.filesize_approx ?? Number.POSITIVE_INFINITY,
    );

    return leftSize - rightSize;
  })[0];
};

// ─── Cache & dedup ────────────────────────────────────────────────────────────

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const searchCache = new NodeCache({ stdTTL: 600 });

// Persistent disk cache for resolved streams to survive restarts
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
    if (!obj || !obj.storedAt) return null;
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

/**
 * Lấy stream URL + duration trong 1 process duy nhất via --print.
 * Nhanh hơn dump-single-json vì không parse toàn bộ metadata.
 */
const fetchStream = async (videoUrl) => {
  const resolveWithFlags = async (flags) => {
    const info = await youtubedl(videoUrl, {
      ...buildYtDlpFlags(flags),
      getUrl: true,
      format: AUDIO_FORMAT,
      forceIpv4: true,
    });

    // const format = chooseBestAudioFormat(info);
    const streamUrl = String(info).trim();

    if (!streamUrl) throw new Error("yt-dlp returned empty stream URL");

    return {
      streamUrl,
      // audioExt: format?.ext ?? null,
      // formatId: format?.format_id ?? null,
      // abr: format?.abr ?? null,
      // duration: null,
    };
  };

  try {
    return await resolveWithFlags(YT_DLP_FLAGS);
  } catch (primaryError) {
    console.warn(
      `[stream] primary yt-dlp config failed for ${videoUrl}:`,
      primaryError.message,
    );

    return await resolveWithFlags(YT_DLP_FALLBACK_FLAGS);
  }
};

// ─── Cache utilities ──────────────────────────────────────────────────────────

const getOrFetchStream = (videoUrl) => {
  const key = `stream:${videoUrl}`;

  // Đang fetch → reuse
  if (pendingStreams.has(key)) {
    console.log(`[stream-cache] pending reuse: ${videoUrl}`);
    return pendingStreams.get(key);
  }

  // Check memory cache
  const mem = streamCache.get(key);
  if (mem) {
    console.log(`[stream-cache] memory hit: ${videoUrl}`);
    return Promise.resolve(mem);
  }

  // Check disk cache
  try {
    const disk = readDiskCache(videoUrl);
    if (disk) {
      console.log(`[stream-cache] disk hit: ${videoUrl}`);
      streamCache.set(key, disk);
      return Promise.resolve(disk);
    }
  } catch (e) {
    // ignore disk read errors
  }

  const promise = fetchStream(videoUrl)
    .then((payload) => {
      streamCache.set(key, payload);
      try {
        writeDiskCache(videoUrl, payload);
      } catch (e) {
        // ignore
      }
      return payload;
    })
    .finally(() => pendingStreams.delete(key));

  pendingStreams.set(key, promise);
  return promise;
};

// Prefetch queue with limited concurrency
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
        // process next
        setImmediate(processPrefetchQueue);
      });
  }
};

const enqueuePrefetch = (videoUrl, label = "prefetch") => {
  // avoid queueing duplicates
  if (prefetchQueue.find((q) => q.videoUrl === videoUrl)) return;
  prefetchQueue.push({ videoUrl, label });
  processPrefetchQueue();
};

const collectStreamBestCandidateIds = async (query, providedIds = []) => {
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
    const searchKey = `search:${query.toLowerCase()}`;
    let results = searchCache.get(searchKey);

    if (!results) {
      results = await (pendingSearches.get(searchKey) ??
        (async () => {
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
          for (const item of items.slice(0, 3)) {
            if (item?.id) {
              enqueuePrefetch(
                `https://www.youtube.com/watch?v=${item.id}`,
                "search-warm",
              );
            }
          }
          return items;
        })());
    }

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

// POST /music/prefetch { videoUrls: string[] }
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

app.post("/music/stream-best", async (req, res) => {
  const start = Date.now();

  try {
    const query = String(req.body?.query ?? "").trim();

    if (!query) {
      return res.status(400).json({
        message: "Missing query",
      });
    }

    const videoIds = await collectStreamBestCandidateIds(query);

    if (!videoIds.length) {
      return res.status(404).json({
        message: "No candidates found",
      });
    }

    const winner = await Promise.any(
      videoIds.slice(0, 5).map(async (id) => {
        const videoUrl = `https://www.youtube.com/watch?v=${id}`;

        const { streamUrl } = await getOrFetchStream(videoUrl);

        return streamUrl;
      }),
    );

    console.log(`[stream-best] resolved "${query}" in ${Date.now() - start}ms`);

    return res.json({
      streamUrl: winner,
    });
  } catch (err) {
    console.warn(`[stream-best] failed "${req.body?.query}":`, err?.message);

    return res.status(404).json({
      message: "No playable stream found",
    });
  }
});
// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
