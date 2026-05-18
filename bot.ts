import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/NewMessage.js";
import { CallbackQuery } from "telegram/events/CallbackQuery.js";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import type { CallbackQueryEvent } from "telegram/events/CallbackQuery.js";
import { Button } from "telegram/tl/custom/button.js";
import type { BigInteger } from "big-integer";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import { logger } from "./lib/logger";

// ── Env ───────────────────────────────────────────────────────────────────────
const TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

let API_ID = parseInt(process.env["TELEGRAM_API_ID"] ?? "0", 10);
let API_HASH = process.env["TELEGRAM_API_HASH"] ?? "";

if ((isNaN(API_ID) || API_ID === 0) && API_HASH) {
  const altId = parseInt(API_HASH, 10);
  const altHash = process.env["TELEGRAM_API_ID"] ?? "";
  if (!isNaN(altId) && altId > 0 && altHash.length > 10) {
    API_ID = altId;
    API_HASH = altHash;
    logger.warn("TELEGRAM_API_ID/HASH were swapped — auto-corrected");
  }
}

if (!API_ID || !API_HASH) throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");

// ── GramJS client ─────────────────────────────────────────────────────────────
const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
  connectionRetries: 5,
  useWSS: false,
});

// ── Constants ─────────────────────────────────────────────────────────────────
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/i;
const BOT_API_LIMIT = 48 * 1024 * 1024;
const MAX_SIZE = 1024 * 1024 * 1024;

// Concurrent fragments for faster downloads (NOT for Instagram — causes 429)
const YTDLP_FAST_FLAGS = "--concurrent-fragments 4 --no-part";
// Instagram-safe flags — no concurrent fragments to avoid rate limiting
const YTDLP_IG_FLAGS   = "--no-part";

// ── Pending quality sessions ──────────────────────────────────────────────────
interface PendingSession {
  url: string;
  expiresAt: number;
}
const pendingSessions = new Map<string, PendingSession>();

// ── Quality options ───────────────────────────────────────────────────────────
const QUALITY_OPTIONS = [
  { label: "🔵 360p",        id: "360",  fmt: "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]" },
  { label: "🟢 720p HD",     id: "720",  fmt: "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]" },
  { label: "🟡 1080p FHD",   id: "1080", fmt: "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]" },
  { label: "⚡ Best Quality", id: "best", fmt: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function runCommand(cmd: string, timeoutMs = 40 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function fetchHtml(url: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    proto.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 20000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
          fetchHtml(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
          return;
        }
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => resolve(data));
      },
    ).on("error", reject).on("timeout", () => reject(new Error("Fetch timeout")));
  });
}

function downloadHttpFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = require("node:fs").createWriteStream(dest);
    proto
      .get(
        url,
        { headers: { "User-Agent": "Mozilla/5.0", Referer: new URL(url).origin } },
        (res) => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
        },
      )
      .on("error", reject);
  });
}

function getVideoFiles(dir: string, files: string[]): string[] {
  return files
    .filter((f) => [".mp4", ".mkv", ".webm", ".avi", ".mov"].some((e) => f.endsWith(e)))
    .map((f) => path.join(dir, f));
}

// ── Instagram helpers ─────────────────────────────────────────────────────────
const IG_PROFILE_REGEX = /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|tv\/|stories\/|explore\/)([a-zA-Z0-9._]{1,30})\/?(?:\?.*)?$/;
const IG_STORY_REGEX   = /^https?:\/\/(?:www\.)?instagram\.com\/stories\/([a-zA-Z0-9._]{1,30})/;

function isInstagramUrl(url: string): boolean {
  return /instagram\.com/i.test(url);
}

/** Strip tracking params (igsh, img_index, etc.) Instagram appends to shared URLs */
function cleanInstagramUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!isInstagramUrl(url)) return url;
    // Keep only path — drop all query params for Instagram
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Returns username if URL is an Instagram profile/story URL (not a post/reel) */
function parseInstagramStory(url: string): string | null {
  const clean = cleanInstagramUrl(url);
  const m = clean.match(IG_STORY_REGEX) ?? clean.match(IG_PROFILE_REGEX);
  return m ? m[1] : null;
}

// ── TeraBox ───────────────────────────────────────────────────────────────────
const TERABOX_DOMAINS = [
  "terabox.com", "teraboxapp.com", "1024tera.com",
  "terafileshare.com", "terasharelink.com",
  "momerybox.com", "tibibox.com", "4funbox.com",
];
function isTeraboxUrl(url: string) { return TERABOX_DOMAINS.some((d) => url.includes(d)); }

async function downloadTerabox(url: string, outputDir: string): Promise<string> {
  try {
    const out = path.join(outputDir, "%(title)s.%(ext)s");
    await runCommand(`yt-dlp --no-playlist --no-warnings ${YTDLP_FAST_FLAGS} -o "${out}" "${url}"`, 10 * 60_000);
    const files = await fs.readdir(outputDir);
    const f = files.find((x) => [".mp4", ".mkv", ".webm", ".avi"].some((e) => x.endsWith(e)));
    if (f) return path.join(outputDir, f);
  } catch { /* fallback to direct extraction */ }

  const html = await fetchHtml(url);
  const shareMatch = url.match(/\/s\/([a-zA-Z0-9_-]+)/);
  const ukMatch = html.match(/"uk"\s*:\s*(\d+)/);
  const fsIdMatch = html.match(/"fs_id"\s*:\s*(\d+)/);
  const dpLogidMatch = html.match(/"dp-logid"\s*:\s*"([^"]+)"/);

  if (!shareMatch || !ukMatch || !fsIdMatch) throw new Error("TeraBox: Could not extract file info");

  const apiUrl = `https://www.terabox.com/share/download?uk=${ukMatch[1]}&shareid=${shareMatch[1]}&fs_id=${fsIdMatch[1]}&dp-logid=${dpLogidMatch?.[1] ?? ""}`;
  const outFile = path.join(outputDir, "terabox_video.mp4");
  await downloadHttpFile(apiUrl, outFile);

  const stat = await fs.stat(outFile);
  if (stat.size < 1000) throw new Error("TeraBox: Download failed");
  return outFile;
}

// ── Generic HTML video scraper ────────────────────────────────────────────────
async function scrapeVideoFromPage(pageUrl: string, outputDir: string): Promise<string | null> {
  logger.info({ pageUrl }, "Trying HTML video scraper");
  let html: string;
  try { html = await fetchHtml(pageUrl); } catch { return null; }

  const patterns = [
    /["'`](https?:\/\/[^"'`\s]+\.mp4(?:[?#][^"'`\s]*)?)['"` ]/gi,
    /["'`](https?:\/\/[^"'`\s]+\.webm(?:[?#][^"'`\s]*)?)['"` ]/gi,
    /["'`](https?:\/\/[^"'`\s]+\.m3u8(?:[?#][^"'`\s]*)?)['"` ]/gi,
    /"(?:file|src|video_url|videoUrl|mp4|source|stream|hls|cdn_url)"\s*:\s*["'`]?(https?:\/\/[^"'`\s,}]+)/gi,
    /(?:source|src)\s*[:=]\s*["'`](https?:\/\/[^"'`\s]+\.(?:mp4|webm|m3u8)[^"'`\s]*)/gi,
  ];

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const pattern of patterns) {
    for (const m of html.matchAll(pattern)) {
      const u = m[1];
      if (u && !seen.has(u)) { seen.add(u); candidates.push(u); }
    }
  }

  if (candidates.length === 0) return null;

  const videoUrl = candidates[0];
  const isHls = videoUrl.includes(".m3u8");
  const outFile = path.join(outputDir, "scraped_video.mp4");

  if (isHls) {
    await runCommand(`ffmpeg -y -headers "Referer: ${pageUrl}" -i "${videoUrl}" -c copy "${outFile}"`, 20 * 60_000);
  } else {
    await downloadHttpFile(videoUrl, outFile);
  }

  const stat = await fs.stat(outFile).catch(() => null);
  if (!stat || stat.size < 10_000) return null;
  return outFile;
}

// ── yt-dlp downloader with fallbacks ─────────────────────────────────────────
async function downloadWithYtdlp(url: string, outputDir: string, fmt: string): Promise<string> {
  const outputTemplate = path.join(outputDir, "%(title)s.%(ext)s");

  // Instagram URLs — strip tracking params + use safe (non-concurrent) flags
  const isIG = isInstagramUrl(url);
  const cleanUrl = isIG ? cleanInstagramUrl(url) : url;
  const speedFlags = isIG ? YTDLP_IG_FLAGS : YTDLP_FAST_FLAGS;

  const tryDownload = async (cmd: string): Promise<boolean> => {
    try {
      await runCommand(cmd, 40 * 60_000);
      const files = await fs.readdir(outputDir);
      return files.some((f) => [".mp4", ".mkv", ".webm", ".avi"].some((e) => f.endsWith(e)));
    } catch {
      return false;
    }
  };

  const findDownloaded = async (): Promise<string> => {
    const files = await fs.readdir(outputDir);
    return path.join(outputDir, files.find((x) => [".mp4", ".mkv", ".webm", ".avi"].some((e) => x.endsWith(e)))!);
  };

  const base = `yt-dlp --no-playlist --no-warnings ${speedFlags}`;

  // Attempt 1: requested format
  if (await tryDownload(`${base} -f "${fmt}" --merge-output-format mp4 -o "${outputTemplate}" "${cleanUrl}"`)) {
    return findDownloaded();
  }

  // Attempt 2: best available (ignore format filter)
  if (await tryDownload(`${base} --merge-output-format mp4 -o "${outputTemplate}" "${cleanUrl}"`)) {
    return findDownloaded();
  }

  // Attempt 3: force generic extractor
  if (await tryDownload(`${base} --force-generic-extractor -o "${outputTemplate}" "${cleanUrl}"`)) {
    return findDownloaded();
  }

  // Attempt 4: HTML scraper (not useful for Instagram, but fine for others)
  if (!isIG) {
    logger.info({ url }, "All yt-dlp attempts failed — trying HTML scraper");
    const scraped = await scrapeVideoFromPage(url, outputDir);
    if (scraped) return scraped;
  }

  throw new Error("unsupported_url");
}

// ── Instagram Stories downloader ──────────────────────────────────────────────
async function downloadInstagramStories(username: string, outputDir: string): Promise<string[]> {
  const storiesUrl = `https://www.instagram.com/stories/${username}/`;
  const outputTemplate = path.join(outputDir, "%(id)s.%(ext)s");
  // No concurrent-fragments for Instagram — causes 429 rate limiting
  const cmd = `yt-dlp --no-warnings ${YTDLP_IG_FLAGS} --merge-output-format mp4 -o "${outputTemplate}" "${storiesUrl}"`;

  const runWithRetry = async (attempt: number): Promise<void> => {
    try {
      await runCommand(cmd, 15 * 60_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("login") || msg.includes("private") || msg.includes("sign in")) {
        throw new Error("ig_private");
      }
      if (msg.includes("429") || msg.includes("Too Many Requests")) {
        if (attempt < 2) {
          logger.warn({ username, attempt }, "Instagram 429 — retrying after delay");
          await new Promise((r) => setTimeout(r, 5000 * attempt));
          return runWithRetry(attempt + 1);
        }
        throw new Error("ig_rate_limit");
      }
      if (
        msg.includes("No video formats found") ||
        msg.includes("Unable to download") ||
        msg.includes("no formats found") ||
        msg.includes("This content is not available")
      ) {
        throw new Error("ig_no_stories");
      }
      // Any other error: treat as no stories (account may have none)
      logger.warn({ username, msg }, "Instagram stories download failed");
      throw new Error("ig_no_stories");
    }
  };

  await runWithRetry(1);

  const allFiles = await fs.readdir(outputDir);
  const videos = getVideoFiles(outputDir, allFiles);

  // Also grab images (Instagram stories can be photos)
  const images = allFiles
    .filter((f) => [".jpg", ".jpeg", ".png", ".webp"].some((e) => f.endsWith(e)))
    .map((f) => path.join(outputDir, f));

  return [...videos, ...images];
}

// ── Send a single video via GramJS MTProto ────────────────────────────────────
async function sendVideo(
  chatId: BigInteger,
  videoPath: string,
  editFn: (text: string) => Promise<void>,
  caption?: string,
): Promise<void> {
  const stat = await fs.stat(videoPath);
  const sizeMB = formatSize(stat.size);

  if (stat.size > MAX_SIZE) {
    await editFn(`❌ File bahut badi hai (${sizeMB}). Sirf 1GB tak support hai.`);
    return;
  }

  if (stat.size <= BOT_API_LIMIT) {
    await editFn(`✅ Download done! (${sizeMB}) Bhej raha hoon...`);
  } else {
    await editFn(`✅ Download done! (${sizeMB})\n📤 Badi file — MTProto se upload ho rahi hai...`);
  }

  let lastUpdate = Date.now();
  const isLarge = stat.size > BOT_API_LIMIT;

  await client.sendFile(chatId, {
    file: videoPath,
    caption: caption ?? `✅ Yeh lo teri video! (${sizeMB})`,
    forceDocument: false,
    workers: 4,
    progressCallback: (progress: number) => {
      const now = Date.now();
      if (isLarge && now - lastUpdate > 5000) {
        lastUpdate = now;
        const pct = Math.round(progress * 100);
        editFn(`📤 Upload ho raha hai... ${pct}% / ${sizeMB}`).catch(() => {});
      }
    },
  });
}

// ── Core download + send pipeline ─────────────────────────────────────────────
async function processDownload(
  chatId: BigInteger,
  url: string,
  fmt: string,
  statusMsgId: number,
) {
  const editStatus = async (text: string) => {
    try { await client.editMessage(chatId, { message: statusMsgId, text }); } catch { /* ignore */ }
  };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tgbot-"));

  try {
    await editStatus("📥 Download ho rahi hai... please wait...");

    let videoPath: string;
    if (isTeraboxUrl(url)) {
      await editStatus("📥 TeraBox se download ho rahi hai...");
      videoPath = await downloadTerabox(url, tmpDir);
    } else {
      videoPath = await downloadWithYtdlp(url, tmpDir, fmt);
    }

    await sendVideo(chatId, videoPath, editStatus);
    await client.deleteMessages(chatId, [statusMsgId], { revoke: true }).catch(() => {});
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, url }, "Download/send failed");

    let userMsg = "❌ Video download nahi ho saki. Dobara try karo.";
    if (errMsg.includes("unsupported_url")) {
      userMsg = "❌ Yeh website supported nahi hai. Direct video file ka URL try karo (jisme .mp4 ho).";
    } else if (errMsg.includes("private") || errMsg.includes("login") || errMsg.includes("sign in")) {
      userMsg = "❌ Yeh video private hai ya login chahiye. Public video ka link bhejo.";
    } else if (errMsg.includes("too large") || errMsg.includes("filesize")) {
      userMsg = "❌ Video bahut badi hai. Chhoti quality choose karo.";
    } else if (errMsg.includes("TeraBox")) {
      userMsg = "❌ TeraBox link kaam nahi kiya. Check karo ki link public ho.";
    }

    await editStatus(userMsg);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Instagram Stories pipeline ────────────────────────────────────────────────
async function processInstagramStories(chatId: BigInteger, username: string, statusMsgId: number) {
  const editStatus = async (text: string) => {
    try { await client.editMessage(chatId, { message: statusMsgId, text }); } catch { /* ignore */ }
  };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tgbot-ig-"));

  try {
    await editStatus(`📥 @${username} ki stories download ho rahi hain...`);

    const videos = await downloadInstagramStories(username, tmpDir);

    if (videos.length === 0) {
      await editStatus(`❌ @${username} ki koi active story nahi mili ya account private hai.`);
      return;
    }

    await editStatus(`✅ ${videos.length} stor${videos.length === 1 ? "y" : "ies"} mili! Upload ho rahi hain...`);

    for (let i = 0; i < videos.length; i++) {
      const vp = videos[i];
      const stat = await fs.stat(vp);
      const sizeMB = formatSize(stat.size);

      if (stat.size > MAX_SIZE) {
        await client.sendMessage(chatId, {
          message: `⚠️ Story ${i + 1} bahut badi hai (${sizeMB}), skip kar raha hoon.`,
        });
        continue;
      }

      await client.sendFile(chatId, {
        file: vp,
        caption: `📸 @${username} — Story ${i + 1}/${videos.length} (${sizeMB})`,
        forceDocument: false,
        workers: 4,
      });
    }

    await client.deleteMessages(chatId, [statusMsgId], { revoke: true }).catch(() => {});
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, username }, "Instagram stories download failed");

    let userMsg = "❌ Stories download nahi ho saki. Dobara try karo.";
    if (errMsg === "ig_private") {
      userMsg = `❌ @${username} ka account private hai. Sirf public accounts ki stories download ho sakti hain.`;
    } else if (errMsg === "ig_no_stories") {
      userMsg = `❌ @${username} ki koi active story nahi hai abhi, ya stories expired ho gayi hain.`;
    } else if (errMsg === "ig_rate_limit") {
      userMsg = `⚠️ Instagram ne temporarily block kar diya (rate limit). 2-3 minute baad dobara try karo.`;
    }

    await editStatus(userMsg);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
client.addEventHandler(async (event: NewMessageEvent) => {
  const msg = event.message;
  if (!msg || msg.out) return;

  const chatId = msg.chatId;
  if (!chatId) return;

  const text = (msg.text ?? "").trim();

  if (text === "/start") {
    await client.sendMessage(chatId, {
      message:
        "Namaste! 👋\n\n" +
        "Koi bhi video link bhejo — main seedha download karke bhej dunga!\n\n" +
        "✅ *Supported:*\n" +
        "• YouTube, YouTube Shorts\n" +
        "• Instagram reels, posts, stories\n" +
        "• Twitter/X, TikTok, Facebook\n" +
        "• Vimeo, Dailymotion, TeraBox\n" +
        "• Kisi bhi website ka .mp4/.m3u8 URL\n" +
        "• 1000+ aur websites\n\n" +
        "📸 *Instagram Stories:*\n" +
        "Profile URL bhejo (`instagram.com/username`) — saari stories aa jayengi!\n\n" +
        "📦 *Max size:* 1GB\n" +
        "🎯 *Quality:* Link bhejne ke baad choose karo",
      parseMode: "markdown",
    });
    return;
  }

  const urlMatch = text.match(URL_REGEX);
  if (!urlMatch) {
    await client.sendMessage(chatId, {
      message: "Koi valid link nahi mila. Please ek video URL bhejo.",
    });
    return;
  }

  // Clean trailing punctuation Telegram appends, then strip IG tracking params
  const rawUrl = urlMatch[0].replace(/[)>.,;!?]+$/, "");
  const url = isInstagramUrl(rawUrl) ? cleanInstagramUrl(rawUrl) : rawUrl;

  // ── Instagram Story/Profile URL ───────────────────────────────────────────
  const igUsername = parseInstagramStory(url);
  if (igUsername) {
    const statusMsg = await client.sendMessage(chatId, {
      message: `📸 Instagram profile mila! @${igUsername} ki stories dhundh raha hoon...`,
    });
    await processInstagramStories(chatId, igUsername, statusMsg.id);
    return;
  }

  // ── TeraBox: skip quality selection ──────────────────────────────────────
  if (isTeraboxUrl(url)) {
    const statusMsg = await client.sendMessage(chatId, {
      message: "⏳ TeraBox link mila! Download shuru ho rahi hai...",
    });
    await processDownload(chatId, url, QUALITY_OPTIONS[3].fmt, statusMsg.id);
    return;
  }

  // ── Quality selection keyboard ────────────────────────────────────────────
  const sessionKey = `${chatId}_${Date.now()}`;
  pendingSessions.set(sessionKey, { url, expiresAt: Date.now() + 5 * 60_000 });
  setTimeout(() => pendingSessions.delete(sessionKey), 5 * 60_000);

  const shortUrl = url.length > 55 ? url.slice(0, 55) + "..." : url;

  await client.sendMessage(chatId, {
    message: `🔗 Link mila!\n\`${shortUrl}\`\n\nKaunsi quality chahiye?`,
    parseMode: "markdown",
    buttons: [
      [
        Button.inline(QUALITY_OPTIONS[0].label, Buffer.from(`dl:${sessionKey}:360`)),
        Button.inline(QUALITY_OPTIONS[1].label, Buffer.from(`dl:${sessionKey}:720`)),
      ],
      [
        Button.inline(QUALITY_OPTIONS[2].label, Buffer.from(`dl:${sessionKey}:1080`)),
        Button.inline(QUALITY_OPTIONS[3].label, Buffer.from(`dl:${sessionKey}:best`)),
      ],
    ],
  });
}, new NewMessage({}));

// ── Callback query handler (quality button press) ─────────────────────────────
client.addEventHandler(async (event: CallbackQueryEvent) => {
  const data = event.data?.toString("utf8") ?? "";
  if (!data.startsWith("dl:")) return;

  await event.answer({ message: "⏳ Processing..." });

  const lastColon = data.lastIndexOf(":");
  const sessionKey = data.slice(3, lastColon);
  const qualityId = data.slice(lastColon + 1);

  const pending = pendingSessions.get(sessionKey);
  const chatId = event.chatId;

  if (!chatId) return;
  if (!pending || Date.now() > pending.expiresAt) {
    await event.edit({ message: event.messageId, text: "❌ Session expire ho gaya. Link dobara bhejo." });
    return;
  }

  pendingSessions.delete(sessionKey);
  const quality = QUALITY_OPTIONS.find((q) => q.id === qualityId) ?? QUALITY_OPTIONS[3];

  await event.edit({
    message: event.messageId,
    text: `⏳ ${quality.label} quality mein download ho rahi hai...`,
  });

  await processDownload(chatId, pending.url, quality.fmt, event.messageId);
}, new CallbackQuery({}));

// ── Export ────────────────────────────────────────────────────────────────────
export async function startBot() {
  await client.start({ botAuthToken: TOKEN! });
  logger.info("Telegram bot ready — GramJS only mode (messages + uploads via MTProto)");
}
