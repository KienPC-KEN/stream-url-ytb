import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import yts from "@vreden/youtube_scraper";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const SEARCH_CACHE_TTL = 600;
const MP3_CACHE_TTL = 900;

// ─────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────

const searchCache = new NodeCache({
  stdTTL: SEARCH_CACHE_TTL,
  checkperiod: 120,
});

const mp3Cache = new NodeCache({
  stdTTL: MP3_CACHE_TTL,
  checkperiod: 120,
});

const pendingSearches = new Map();
const pendingMp3 = new Map();

// ─────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────

const now = () => performance.now();

const logTime = (label, start) => {
  const ms = (now() - start).toFixed(0);

  console.log(`⚡ ${label}: ${ms}ms`);
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retry = async (fn, retries = 2) => {
  let lastError;

  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (i < retries) {
        await sleep(500);
      }
    }
  }

  throw lastError;
};

const filterResults = (results = []) => {
  return results
    .filter((item) => {
      const title = String(item.title || "").toLowerCase();

      return (
        !title.includes("karaoke") &&
        !title.includes("live") &&
        !title.includes("remix") &&
        !title.includes("slowed") &&
        !title.includes("8d")
      );
    })
    .slice(0, 5)
    .map((item) => ({
      title: item.title,
      url: item.url,
      thumbnail: item.thumbnail,
      duration: item.duration,
    }));
};

// ─────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────

const searchYouTube = async (query) => {
  const normalized = query.toLowerCase().trim();

  const cacheKey = `search:${normalized}`;

  const cached = searchCache.get(cacheKey);

  if (cached) {
    console.log(`🟢 SEARCH CACHE HIT: ${normalized}`);

    return cached;
  }

  console.log(`🟡 SEARCH CACHE MISS: ${normalized}`);

  if (pendingSearches.has(cacheKey)) {
    return pendingSearches.get(cacheKey);
  }

  const promise = retry(async () => {
    const start = now();

    const results = await yts.search(normalized);

    logTime(`YouTube search "${normalized}"`, start);

    const filtered = filterResults(results.results || []);

    searchCache.set(cacheKey, filtered);

    return filtered;
  }).finally(() => {
    pendingSearches.delete(cacheKey);
  });

  pendingSearches.set(cacheKey, promise);

  return promise;
};

// ─────────────────────────────────────────────────────────────
// MP3
// ─────────────────────────────────────────────────────────────

const fetchMp3 = async (url) => {
  return retry(async () => {
    const start = now();

    const data = await yts.ytmp3(url, 92);

    logTime(`MP3 fetch`, start);

    if (!data?.download) {
      throw new Error("MP3 not found");
    }

    return data.download;
  });
};

const getOrFetchMp3 = async (url) => {
  const cacheKey = `mp3:${url}`;

  const cached = mp3Cache.get(cacheKey);

  if (cached) {
    console.log(`🟢 MP3 CACHE HIT`);

    return cached;
  }

  console.log(`🟡 MP3 CACHE MISS`);

  if (pendingMp3.has(cacheKey)) {
    return pendingMp3.get(cacheKey);
  }

  const promise = fetchMp3(url)
    .then((data) => {
      mp3Cache.set(cacheKey, data);

      return data;
    })
    .finally(() => {
      pendingMp3.delete(cacheKey);
    });

  pendingMp3.set(cacheKey, promise);

  return promise;
};

// ─────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────

app.get("/", (_, res) => {
  return res.json({
    status: "ok",
    service: "music-backend",
  });
});

// ─────────────────────────────────────────────────────────────
// SEARCH MUSIC
// ─────────────────────────────────────────────────────────────

app.get("/music/search", async (req, res) => {
  const totalStart = now();

  try {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        message: "Missing query",
      });
    }

    const results = await searchYouTube(query);

    logTime(`/music/search TOTAL`, totalStart);

    return res.json(results);
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET MP3 FROM URL
// ─────────────────────────────────────────────────────────────

app.get("/music/mp3", async (req, res) => {
  const totalStart = now();

  try {
    const url = String(req.query.url || "").trim();

    if (!url) {
      return res.status(400).json({
        message: "Missing url",
      });
    }

    const data = await getOrFetchMp3(url);

    logTime(`/music/mp3 TOTAL`, totalStart);

    return res.json(data);
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// SEARCH + AUTO MP3
// ─────────────────────────────────────────────────────────────

app.post("/music/mp3", async (req, res) => {
  const totalStart = now();

  try {
    const query = String(req.body.query || "").trim();

    if (!query) {
      return res.status(400).json({
        message: "Missing query",
      });
    }

    const results = await searchYouTube(query);

    if (!results.length) {
      return res.status(404).json({
        message: "No results found",
      });
    }

    const best = results[0];

    const mp3 = await getOrFetchMp3(best.url);

    logTime(`POST /music/mp3 TOTAL`, totalStart);

    return res.json({
      query,
      video: best,
      mp3,
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});