import express from "express";
import cors from "cors";
import NodeCache from "node-cache";
import youtubeDlExec from "youtube-dl-exec";

const { create } = youtubeDlExec;
const ytDlp = create("yt-dlp");

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const SEARCH_CACHE_TTL = 60 * 10;
const AUDIO_CACHE_TTL = 60 * 60 * 5;

const FILTER_KEYWORDS = ["karaoke", "live", "remix", "slowed", "8d", "reverb"];
const MAX_DURATION_SEC = 600;
const SEARCH_LIMIT = 10;

// ─────────────────────────────────────────────────────────────
// CACHE & DEDUP
// ─────────────────────────────────────────────────────────────

const searchCache = new NodeCache({
  stdTTL: SEARCH_CACHE_TTL,
  checkperiod: 120,
});
const audioCache = new NodeCache({ stdTTL: AUDIO_CACHE_TTL, checkperiod: 300 });

const pendingSearches = new Map();
const pendingAudio = new Map();

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

// ─────────────────────────────────────────────────────────────
// SEARCH — dùng yt-dlp thay @distube/ytsr (ổn định hơn)
// ─────────────────────────────────────────────────────────────

const searchYouTube = (query) => {
  const key = `search:${query.toLowerCase().trim()}`;
  const cached = searchCache.get(key);

  if (cached) {
    console.log(`🟢 SEARCH HIT: ${query}`);
    return Promise.resolve(cached);
  }

  console.log(`🟡 SEARCH MISS: ${query}`);

  return withDedup(pendingSearches, key, () =>
    retry(async () => {
      const start = now();

      // ytsearch{N}: tìm N kết quả trên YouTube
      const results = await ytDlp(`ytsearch${SEARCH_LIMIT}:${query}`, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        flatPlaylist: true, // chỉ lấy metadata, không fetch từng video
      });

      logTime(`search "${query}"`, start);

      const items = (results?.entries ?? [])
        .filter((e) => {
          const title = (e.title || "").toLowerCase();
          if (FILTER_KEYWORDS.some((kw) => title.includes(kw))) return false;
          if ((e.duration ?? 0) > MAX_DURATION_SEC) return false;
          return true;
        })
        .slice(0, 5)
        .map((e) => ({
          title: e.title,
          url: `https://www.youtube.com/watch?v=${e.id}`,
          thumbnail: e.thumbnail,
          duration: e.duration, // số giây
        }));

      searchCache.set(key, items);
      return items;
    }),
  );
};

const fetchAudioUrl = (videoUrl) =>
  retry(async () => {
    const start = now();
    const result = await ytDlp(videoUrl, {
      dumpSingleJson: true,
      noPlaylist: true,
      format: "bestaudio[ext=m4a][vcodec=none]",
      noWarnings: true,
      noCheckCertificates: true,
    });
    const audioFormat = result.formats
      ?.filter(
        (f) =>
          f.acodec !== "none" &&
          f.vcodec === "none" &&
          f.protocol !== "m3u8_native" &&
          f.protocol !== "m3u8" &&
          f.ext === "m4a",
      )
      ?.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const audioUrl = audioFormat?.url;
    if (!audioUrl?.startsWith("http")) {
      throw new Error("No audio URL from yt-dlp");
    }
    logTime("audio url (yt-dlp)", start);
    console.log({
      duration: result.duration,
      selectedDuration: audioFormat?.duration,
      protocol: audioFormat?.protocol,
      ext: audioFormat?.ext,
      abr: audioFormat?.abr,
      formatId: audioFormat?.format_id,
    });
    return {
      url: audioUrl,
      duration: result.duration ?? 0,
      mimeType: result.ext ?? "audio/mp4",
      bitrate: result.abr ?? null,
      expireAt: Date.now() + AUDIO_CACHE_TTL * 1000,
    };
  });

const getAudioUrl = (videoUrl) => {
  const key = `audio:${videoUrl}`;
  const cached = audioCache.get(key);

  if (cached) {
    console.log("🟢 AUDIO HIT");
    return Promise.resolve(cached);
  }

  console.log("🟡 AUDIO MISS");

  return withDedup(pendingAudio, key, () =>
    fetchAudioUrl(videoUrl).then((data) => {
      audioCache.set(key, data);
      return data;
    }),
  );
};

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => res.json({ status: "ok", service: "music-backend" }));

app.post("/music/audio", async (req, res) => {
  const start = now();
  try {
    const query = String(req.body.query || "").trim();
    if (!query)
      return res.status(400).json({ message: "Missing body field: query" });

    const results = await searchYouTube(query);
    if (!results.length)
      return res.status(404).json({ message: "No results found" });

    const best = results[0];
    const audio = await getAudioUrl(best.url);

    logTime("POST /music/audio TOTAL", start);

    return res.json({ video: best, audio: audio });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`),
);
