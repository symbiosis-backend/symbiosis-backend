console.log("AUTO DEPLOY WORKS");
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();

app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

app.use(cors());
app.use(express.json());
app.use("/downloads", express.static("downloads"));

const ONLINE_WINDOW_SECONDS = readIntEnv("ONLINE_WINDOW_SECONDS", 120);
const CHAT_CHANNEL_GLOBAL = "global";
const CHAT_CHANNEL_MAHJONG = "mahjong";
const CHAT_CHANNELS = new Set([CHAT_CHANNEL_GLOBAL, CHAT_CHANNEL_MAHJONG]);
const PROFILE_RESET_ID = process.env.PROFILE_RESET_ID || "profiles_reset_20260422_seed_test_v1";
const SEED_TEST_EMAIL = (process.env.SEED_TEST_EMAIL || "test@symbiosis.local").trim().toLowerCase();
const SEED_TEST_PASSWORD = process.env.SEED_TEST_PASSWORD || "test123456";
const SEED_TEST_DYNASTY_NAME = process.env.SEED_TEST_DYNASTY_NAME || "Test Dynasty";
const SEED_TEST_DYNASTY_ID = process.env.SEED_TEST_DYNASTY_ID || "DY-TEST-000001";
const SEED_TEST_NICKNAME = process.env.SEED_TEST_NICKNAME || "TestPlayer";
const SEED_TEST_PUBLIC_PLAYER_ID = process.env.SEED_TEST_PUBLIC_PLAYER_ID || "MB-TEST0001";
const RANKED_QUEUE_TIMEOUT_SECONDS = readIntEnv("RANKED_QUEUE_TIMEOUT_SECONDS", 90);
const RANKED_MATCH_TTL_SECONDS = readIntEnv("RANKED_MATCH_TTL_SECONDS", 60 * 60 * 3);
const ANDROID_EMBEDDED_VERSION_NAME = "1.0.6";
const ANDROID_EMBEDDED_VERSION_CODE = 100006;
const ANDROID_EMBEDDED_APK_URL = "https://raw.githubusercontent.com/symbiosis-backend/symbiosis-backend/main/downloads/symbiosis-latest.apk";
const ANDROID_EMBEDDED_APK_SHA256 = "a0e2aefdb7bd8526e5c807cb82c6a89ef9e0dbdc20b3b69604fe8bd602d31b29";
const ANDROID_EMBEDDED_APK_SIZE_BYTES = 73519433;
const ANDROID_EMBEDDED_RELEASE_NOTES = "Routes online services through HTTPS dlsymbiosis.com for reliable mobile network connections.";

const rankedQueue = new Map();
const rankedMatches = new Map();

const pool = new Pool({
  user: "game",
  host: "postgres",
  database: "gamedb",
  password: "gamepass",
  port: 5432,
});

function generatePublicPlayerId() {
  const value = Math.random().toString(16).slice(2, 10).toUpperCase();
  return `MB-${value}`;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash, legacyPassword) {
  if (!storedHash) {
    return legacyPassword && String(password) === String(legacyPassword);
  }

  const [salt, hash] = String(storedHash).split(":");
  if (!salt || !hash) {
    return false;
  }

  const candidate = hashPassword(password, salt).split(":")[1];
  if (candidate.length !== hash.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

function normalizeLanguage(value) {
  const language = String(value || "").trim().toLowerCase();
  if (language === "russian" || language === "english" || language === "turkish") {
    return language;
  }
  return "turkish";
}

function normalizeGender(value) {
  const gender = String(value || "").trim().toLowerCase();
  if (gender === "male" || gender === "female" || gender === "other") {
    return gender;
  }
  return "not_specified";
}

function normalizeDynastyName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 48);
}

function normalizeLookup(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeRankTier(value) {
  return String(value || "Unranked").trim().replace(/\s+/g, " ").slice(0, 32) || "Unranked";
}

function clampRankPoints(value) {
  return Math.max(0, Math.min(999999, Math.floor(Number(value) || 0)));
}

function normalizeChatChannel(value) {
  const channel = String(value || CHAT_CHANNEL_GLOBAL).trim().toLowerCase();
  if (channel === "madonna") {
    return CHAT_CHANNEL_MAHJONG;
  }

  return CHAT_CHANNELS.has(channel) ? channel : CHAT_CHANNEL_GLOBAL;
}

function generateDynastyId(dynastyName) {
  const source = normalizeDynastyName(dynastyName)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 6) || "DYN";
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `DY-${source}-${suffix}`;
}

function getSlotIndex(value) {
  const slot = Math.floor(Number(value) || 1);
  return Math.min(3, Math.max(1, slot));
}

function normalizeDeviceId(value) {
  return String(value || "").trim();
}

function getSlotEmail(accountId, slotIndex) {
  return `account-${accountId}-slot-${slotIndex}@slot.symbiosis.local`;
}

function createGuestIdentity(deviceId) {
  const seed = String(deviceId || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 12) || Date.now().toString(36);
  const suffix = crypto.randomBytes(4).toString("hex");

  return {
    email: `${seed.toLowerCase()}-${suffix}@device.symbiosis.local`,
    nickname: `Player_${seed.slice(0, 8)}_${suffix.slice(0, 4)}`,
  };
}

function readIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolEnv(name, fallback) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  return fallback;
}

function getPublicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "http://91.99.176.77:8080").replace(/\/+$/, "");
}

function getFileInfo(relativePath) {
  const filePath = path.join(__dirname, "downloads", relativePath);
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: stat.isFile(),
      sizeBytes: stat.isFile() ? stat.size : 0,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (_) {
    return {
      exists: false,
      sizeBytes: 0,
      updatedAt: null,
    };
  }
}

function getDownloadsStatus() {
  const apk = getFileInfo("symbiosis-latest.apk");
  const manifest = getFileInfo("android-update.json");
  const addressablesDir = path.join(__dirname, "downloads", "addressables", "Android");
  let addressableFiles = [];

  try {
    addressableFiles = fs
      .readdirSync(addressablesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (_) {
    addressableFiles = [];
  }

  return {
    success: true,
    downloadsPath: path.join(__dirname, "downloads"),
    apk,
    manifest,
    addressables: {
      exists: fs.existsSync(addressablesDir),
      fileCount: addressableFiles.length,
      files: addressableFiles.slice(-20),
    },
    checkedAt: new Date().toISOString(),
  };
}

function getAndroidUpdateManifest() {
  const filePath = path.join(__dirname, "downloads", "android-update.json");
  const latestVersionCode = readIntEnv("ANDROID_LATEST_VERSION_CODE", 1);
  const minimumVersionCode = readIntEnv("ANDROID_MIN_VERSION_CODE", 1);
  const apk = getFileInfo("symbiosis-latest.apk");
  const updateUrl = process.env.ANDROID_UPDATE_URL || `${getPublicBaseUrl()}/downloads/symbiosis-latest.apk`;
  const fallback = {
    success: true,
    platform: "android",
    latestVersion: process.env.ANDROID_LATEST_VERSION || "1.0",
    latestVersionCode,
    minimumVersionCode,
    forceUpdate: readBoolEnv("ANDROID_FORCE_UPDATE", false),
    updateUrl,
    apkAvailable: apk.exists,
    apkSizeBytes: apk.sizeBytes,
    releaseNotes: process.env.ANDROID_RELEASE_NOTES || "A new Symbiosis build is available.",
    checkedAt: new Date().toISOString(),
  };
  const embedded = {
    success: true,
    platform: "android",
    latestVersion: ANDROID_EMBEDDED_VERSION_NAME,
    latestVersionCode: ANDROID_EMBEDDED_VERSION_CODE,
    versionName: ANDROID_EMBEDDED_VERSION_NAME,
    versionCode: ANDROID_EMBEDDED_VERSION_CODE,
    minimumVersionCode,
    forceUpdate: false,
    updateUrl: ANDROID_EMBEDDED_APK_URL,
    apkUrl: ANDROID_EMBEDDED_APK_URL,
    apkAvailable: true,
    apkSizeBytes: ANDROID_EMBEDDED_APK_SIZE_BYTES,
    sizeBytes: ANDROID_EMBEDDED_APK_SIZE_BYTES,
    sha256: ANDROID_EMBEDDED_APK_SHA256,
    releaseNotes: ANDROID_EMBEDDED_RELEASE_NOTES,
    checkedAt: new Date().toISOString(),
  };

  try {
    if (!fs.existsSync(filePath)) {
      return embedded.latestVersionCode > fallback.latestVersionCode ? embedded : fallback;
    }

    const fileManifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const resolvedVersionName = fileManifest.versionName || fileManifest.latestVersion || fallback.latestVersion;
    const resolvedVersionCode = Number(fileManifest.versionCode || fileManifest.latestVersionCode || fallback.latestVersionCode);
    const resolvedUpdateUrl = fileManifest.apkUrl || fileManifest.updateUrl || fallback.updateUrl;
    const resolvedManifest = {
      ...fallback,
      ...fileManifest,
      success: true,
      platform: "android",
      latestVersion: resolvedVersionName,
      latestVersionCode: Number.isFinite(resolvedVersionCode) ? resolvedVersionCode : fallback.latestVersionCode,
      updateUrl: resolvedUpdateUrl,
      apkUrl: resolvedUpdateUrl,
      checkedAt: new Date().toISOString(),
    };

    return embedded.latestVersionCode > resolvedManifest.latestVersionCode ? embedded : resolvedManifest;
  } catch (err) {
    console.warn("Android update manifest read failed", err.message);
    return embedded.latestVersionCode > fallback.latestVersionCode ? embedded : fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) {
    return "Unknown size";
  }

  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex++;
  }

  return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function renderAndroidDownloadPage() {
  const manifest = getAndroidUpdateManifest();
  const baseUrl = getPublicBaseUrl();
  const apkUrl = manifest.apkUrl || manifest.updateUrl || `${baseUrl}/downloads/symbiosis-latest.apk`;
  const versionName = manifest.versionName || manifest.latestVersion || "latest";
  const versionCode = manifest.versionCode || manifest.latestVersionCode || "";
  const sizeBytes = manifest.sizeBytes || manifest.apkSizeBytes || 0;
  const releaseNotes = manifest.releaseNotes || "Latest Android build.";
  const updatedAt = manifest.updatedAt || manifest.checkedAt || new Date().toISOString();
  const pageTitle = `Symbiosis Android ${versionName}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d1117">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="Download the latest Symbiosis Android APK.">
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #151b23;
      --text: #f8fafc;
      --muted: #a7b0be;
      --accent: #58c4dc;
      --accent2: #f0b35a;
      --line: rgba(255,255,255,.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at 20% 10%, rgba(88,196,220,.18), transparent 32rem), var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 28px;
    }
    main {
      width: min(720px, 100%);
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(21,27,35,.96), rgba(15,20,27,.96));
      box-shadow: 0 24px 80px rgba(0,0,0,.38);
      border-radius: 18px;
      overflow: hidden;
    }
    .hero {
      padding: 34px;
      border-bottom: 1px solid var(--line);
    }
    .brand {
      color: var(--accent2);
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 13px;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0;
      font-size: clamp(34px, 8vw, 58px);
      line-height: .96;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.55;
    }
    .content {
      padding: 28px 34px 34px;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat {
      background: rgba(255,255,255,.045);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      min-width: 0;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
      margin-bottom: 7px;
    }
    .value {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .button {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 58px;
      width: 100%;
      border-radius: 12px;
      color: #071014;
      background: linear-gradient(180deg, #7de1f2, var(--accent));
      text-decoration: none;
      font-weight: 800;
      font-size: 18px;
      box-shadow: 0 12px 32px rgba(88,196,220,.28);
    }
    .notes {
      margin-top: 20px;
      color: var(--muted);
      line-height: 1.55;
      padding: 16px;
      border-radius: 12px;
      background: rgba(255,255,255,.04);
      border: 1px solid var(--line);
    }
    .direct {
      display: block;
      margin-top: 18px;
      color: var(--accent);
      overflow-wrap: anywhere;
      text-align: center;
    }
    @media (max-width: 640px) {
      body { padding: 14px; }
      .hero, .content { padding: 24px; }
      .meta { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="brand">Symbiosis</div>
      <h1>Android APK</h1>
      <p class="subtitle">Download the latest Android build and install it on your device.</p>
    </section>
    <section class="content">
      <div class="meta">
        <div class="stat">
          <div class="label">Version</div>
          <div class="value">${escapeHtml(versionName)}${versionCode ? ` (${escapeHtml(versionCode)})` : ""}</div>
        </div>
        <div class="stat">
          <div class="label">Size</div>
          <div class="value">${escapeHtml(formatBytes(sizeBytes))}</div>
        </div>
        <div class="stat">
          <div class="label">Updated</div>
          <div class="value">${escapeHtml(new Date(updatedAt).toLocaleDateString("en-GB"))}</div>
        </div>
      </div>
      <a class="button" href="${escapeHtml(apkUrl)}">Download APK</a>
      <div class="notes">${escapeHtml(releaseNotes)}</div>
      <a class="direct" href="${escapeHtml(apkUrl)}">${escapeHtml(apkUrl)}</a>
    </section>
  </main>
</body>
</html>`;
}

function renderSymbiosisLandingPage() {
  const manifest = getAndroidUpdateManifest();
  const baseUrl = getPublicBaseUrl();
  const apkUrl = manifest.apkUrl || manifest.updateUrl || `${baseUrl}/downloads/symbiosis-latest.apk`;
  const versionName = manifest.versionName || manifest.latestVersion || "latest";
  const versionCode = manifest.versionCode || manifest.latestVersionCode || "";
  const sizeBytes = manifest.sizeBytes || manifest.apkSizeBytes || 0;
  const releaseNotes = manifest.releaseNotes || "Latest Android build.";
  const updatedAt = manifest.updatedAt || manifest.checkedAt || new Date().toISOString();
  const supportEmail = "support@dlsymbiosis.com";
  const pageTitle = "DLSymbiosis - Mahjong Battle";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b1014">
  <meta name="description" content="Download DLSymbiosis, a Mahjong Battle game for Android with online profiles, ranked battles, and local Wi-Fi duels.">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="Mahjong Battle for Android. Download the latest APK.">
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1014;
      --ink: #f6f1e7;
      --muted: #b9c4ca;
      --soft: rgba(255,255,255,.08);
      --line: rgba(255,255,255,.14);
      --panel: rgba(18,25,31,.84);
      --panel-strong: rgba(24,35,42,.96);
      --gold: #f2b95f;
      --jade: #65d1b4;
      --red: #d95045;
      --cyan: #6bd9ee;
      --shadow: 0 26px 90px rgba(0,0,0,.36);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(180deg, rgba(7,10,13,.48), rgba(7,10,13,.86)),
        radial-gradient(circle at 78% 8%, rgba(101,209,180,.22), transparent 25rem),
        radial-gradient(circle at 12% 22%, rgba(217,80,69,.18), transparent 25rem),
        #0b1014;
      min-height: 100vh;
    }
    a { color: inherit; }
    .shell { width: min(1160px, calc(100% - 32px)); margin: 0 auto; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(18px);
      background: rgba(11,16,20,.72);
      border-bottom: 1px solid var(--line);
    }
    .nav {
      min-height: 72px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      font-weight: 850;
      letter-spacing: .02em;
    }
    .mark {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      color: #101418;
      background: linear-gradient(135deg, var(--gold), var(--jade));
      font-weight: 900;
      box-shadow: 0 10px 30px rgba(101,209,180,.22);
    }
    .navlinks {
      display: flex;
      align-items: center;
      gap: 18px;
      color: var(--muted);
      font-size: 14px;
    }
    .navlinks a {
      text-decoration: none;
      white-space: nowrap;
    }
    .navlinks a:hover { color: var(--ink); }
    .hero {
      min-height: calc(100vh - 72px);
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(340px, .92fr);
      align-items: center;
      gap: 44px;
      padding: 52px 0 72px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--gold);
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
      font-size: 12px;
      margin-bottom: 18px;
    }
    .eyebrow::before {
      content: "";
      width: 42px;
      height: 2px;
      background: var(--gold);
    }
    h1 {
      margin: 0;
      max-width: 760px;
      font-size: clamp(46px, 7vw, 92px);
      line-height: .92;
      letter-spacing: 0;
    }
    .lead {
      max-width: 660px;
      margin: 24px 0 0;
      color: var(--muted);
      font-size: clamp(18px, 2vw, 22px);
      line-height: 1.55;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 34px;
    }
    .button {
      min-height: 58px;
      padding: 0 24px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      font-weight: 850;
      border: 1px solid var(--line);
    }
    .button.primary {
      color: #0d1114;
      background: linear-gradient(180deg, #ffe0a4, var(--gold));
      border-color: rgba(255,255,255,.16);
      box-shadow: 0 18px 46px rgba(242,185,95,.25);
    }
    .button.secondary {
      color: var(--ink);
      background: rgba(255,255,255,.06);
    }
    .version {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 24px;
      color: var(--muted);
      font-size: 14px;
    }
    .pill {
      border: 1px solid var(--line);
      background: rgba(255,255,255,.045);
      border-radius: 999px;
      padding: 8px 12px;
    }
    .showcase {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(31,45,52,.92), rgba(16,22,28,.92));
      box-shadow: var(--shadow);
      border-radius: 8px;
      overflow: hidden;
    }
    .arena {
      aspect-ratio: 4 / 5;
      padding: 24px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 18px;
      background:
        linear-gradient(135deg, rgba(101,209,180,.14), transparent 40%),
        linear-gradient(315deg, rgba(242,185,95,.16), transparent 45%),
        #121b21;
    }
    .scorebar {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 14px;
      align-items: center;
      font-size: 13px;
      color: var(--muted);
    }
    .scorebar strong { color: var(--ink); }
    .versus {
      color: var(--gold);
      font-weight: 900;
      letter-spacing: .12em;
    }
    .tiles {
      align-self: center;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      transform: rotate(-3deg);
    }
    .tile {
      aspect-ratio: 3 / 4;
      border-radius: 9px;
      background: linear-gradient(180deg, #f7ead4, #bf9a6b);
      border: 2px solid rgba(255,255,255,.18);
      box-shadow: 0 12px 26px rgba(0,0,0,.22);
      display: grid;
      place-items: center;
      color: #18222a;
      font-weight: 900;
    }
    .tile:nth-child(2n) { transform: translateY(12px); }
    .tile:nth-child(3n) { background: linear-gradient(180deg, #9fe6d3, #4e9d8b); }
    .tile:nth-child(5n) { background: linear-gradient(180deg, #f3b2a8, #bc554d); }
    .status {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 14px;
      border-top: 1px solid var(--line);
      padding-top: 16px;
    }
    section.band {
      padding: 72px 0;
      border-top: 1px solid var(--line);
    }
    .section-head {
      max-width: 760px;
      margin-bottom: 28px;
    }
    h2 {
      margin: 0;
      font-size: clamp(30px, 4vw, 52px);
      line-height: 1;
      letter-spacing: 0;
    }
    .section-head p {
      color: var(--muted);
      font-size: 18px;
      line-height: 1.55;
      margin: 16px 0 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }
    .card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 22px;
      min-height: 180px;
    }
    .card .icon {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: rgba(101,209,180,.14);
      color: var(--jade);
      font-weight: 900;
      margin-bottom: 18px;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 20px;
    }
    .card p {
      margin: 0;
      color: var(--muted);
      line-height: 1.52;
    }
    .install {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      align-items: stretch;
    }
    .steps {
      border: 1px solid var(--line);
      background: var(--panel-strong);
      border-radius: 8px;
      padding: 26px;
    }
    ol {
      margin: 18px 0 0;
      padding-left: 22px;
      color: var(--muted);
      line-height: 1.7;
    }
    .release {
      border: 1px solid var(--line);
      background: rgba(255,255,255,.05);
      border-radius: 16px;
      padding: 26px;
    }
    .release p {
      color: var(--muted);
      line-height: 1.6;
      margin: 14px 0 0;
    }
    .direct {
      display: block;
      margin-top: 18px;
      color: var(--cyan);
      overflow-wrap: anywhere;
      text-decoration: none;
      line-height: 1.45;
    }
    .direct:hover { text-decoration: underline; }
    .contact {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: center;
      border: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(101,209,180,.12), rgba(242,185,95,.10));
      border-radius: 8px;
      padding: 30px;
    }
    .contact p {
      color: var(--muted);
      margin: 12px 0 0;
      line-height: 1.6;
    }
    footer {
      padding: 28px 0 42px;
      color: var(--muted);
      border-top: 1px solid var(--line);
      font-size: 14px;
    }
    footer .shell {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    @media (max-width: 880px) {
      .hero, .install, .contact { grid-template-columns: 1fr; }
      .hero { padding-top: 36px; }
      .grid { grid-template-columns: 1fr; }
      .navlinks { display: none; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 22px, 1160px); }
      .button { width: 100%; }
      .arena { padding: 16px; }
      .tiles { gap: 8px; }
      section.band { padding: 52px 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <a class="brand" href="#top" aria-label="DLSymbiosis home">
        <span class="mark">DL</span>
        <span>DLSymbiosis</span>
      </a>
      <nav class="navlinks" aria-label="Primary navigation">
        <a href="#features">Features</a>
        <a href="#install">Install</a>
        <a href="#contact">Contact</a>
      </nav>
    </div>
  </header>
  <main id="top">
    <section class="shell hero">
      <div>
        <div class="eyebrow">Mahjong Battle for Android</div>
        <h1>Build your profile. Pick your fighter. Win the board.</h1>
        <p class="lead">DLSymbiosis turns classic tile matching into a battle arena with characters, progression, online accounts, ranked matchmaking, and local Wi-Fi duels.</p>
        <div class="actions">
          <a class="button primary" href="${escapeHtml(apkUrl)}">Download Android APK</a>
          <a class="button secondary" href="#install">Installation guide</a>
        </div>
        <div class="version">
          <span class="pill">Version ${escapeHtml(versionName)}${versionCode ? ` / ${escapeHtml(versionCode)}` : ""}</span>
          <span class="pill">${escapeHtml(formatBytes(sizeBytes))}</span>
          <span class="pill">Updated ${escapeHtml(new Date(updatedAt).toLocaleDateString("en-GB"))}</span>
        </div>
      </div>
      <div class="showcase" aria-label="Mahjong battle preview">
        <div class="arena">
          <div class="scorebar">
            <span><strong>You</strong><br>Wi-Fi ready</span>
            <span class="versus">VS</span>
            <span style="text-align:right"><strong>Opponent</strong><br>Ranked ready</span>
          </div>
          <div class="tiles">
            <span class="tile">I</span><span class="tile">II</span><span class="tile">III</span><span class="tile">IV</span>
            <span class="tile">A</span><span class="tile">B</span><span class="tile">C</span><span class="tile">D</span>
            <span class="tile">F</span><span class="tile">W</span><span class="tile">T</span><span class="tile">G</span>
          </div>
          <div class="status">
            <span>Local Wi-Fi Battle</span>
            <span>Online Profiles</span>
          </div>
        </div>
      </div>
    </section>
    <section class="band" id="features">
      <div class="shell">
        <div class="section-head">
          <h2>What is inside</h2>
          <p>Fast matches, character choices, account progress, and multiplayer systems are being built into one Android experience.</p>
        </div>
        <div class="grid">
          <article class="card">
            <div class="icon">01</div>
            <h3>Battle Mahjong</h3>
            <p>Clear matching tiles while your character turns successful pairs into pressure against the opponent.</p>
          </article>
          <article class="card">
            <div class="icon">02</div>
            <h3>Wi-Fi Battle</h3>
            <p>Create a room on the same local network, let another player join, and start a direct player-versus-player match.</p>
          </article>
          <article class="card">
            <div class="icon">03</div>
            <h3>Profiles and Progress</h3>
            <p>Keep your player profile, character selection, rank information, rewards, and battle history connected to your account.</p>
          </article>
        </div>
      </div>
    </section>
    <section class="band" id="install">
      <div class="shell install">
        <div class="steps">
          <h2>Install on Android</h2>
          <ol>
            <li>Download the APK from this page.</li>
            <li>Open the file on your Android phone.</li>
            <li>Allow installation from your browser or file manager if Android asks.</li>
            <li>Install, launch, and sign in or create your profile.</li>
          </ol>
        </div>
        <div class="release">
          <h2>Latest build</h2>
          <p>${escapeHtml(releaseNotes)}</p>
          <div class="actions">
            <a class="button primary" href="${escapeHtml(apkUrl)}">Download APK</a>
          </div>
          <a class="direct" href="${escapeHtml(apkUrl)}">${escapeHtml(apkUrl)}</a>
        </div>
      </div>
    </section>
    <section class="band" id="contact">
      <div class="shell contact">
        <div>
          <h2>Contact us</h2>
          <p>Questions, bugs, test feedback, or partnership messages can be sent to our support mailbox. We read player reports and use them for the next Android builds.</p>
        </div>
        <a class="button secondary" href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>
      </div>
    </section>
  </main>
  <footer>
    <div class="shell">
      <span>(c) ${new Date().getFullYear()} DLSymbiosis</span>
      <span>Android APK distribution / ${escapeHtml("dlsymbiosis.com")}</span>
    </div>
  </footer>
</body>
</html>`;
}

function getCharacterContentCatalog() {
  const filePath = path.join(__dirname, "downloads", "content", "characters.json");
  const fallback = {
    success: true,
    version: process.env.CHARACTER_CONTENT_VERSION || "1.0",
    checkedAt: new Date().toISOString(),
    characters: [
      createCharacterContent("Tiger_Male", "Kaplan", "Tiger", "Male", true, 0, 1000, 16, 0.05, 0.05, 0.12, 1.7),
      createCharacterContent("Tiger_Female", "Dişi Kaplan", "Tiger", "Female", false, 10000, 1000, 16, 0.05, 0.05, 0.12, 1.7),
      createCharacterContent("Fox_Male", "Tilki", "Fox", "Male", false, 30000, 900, 14, 0.03, 0.12, 0.18, 1.8),
      createCharacterContent("Fox_Female", "Dişi Tilki", "Fox", "Female", false, 50000, 900, 14, 0.03, 0.12, 0.18, 1.8),
      createCharacterContent("Wolf_Male", "Kurt", "Wolf", "Male", false, 70000, 1100, 15, 0.08, 0.1, 0.1, 1.65),
      createCharacterContent("Wolf_Female", "Dişi Kurt", "Wolf", "Female", false, 90000, 1100, 15, 0.08, 0.1, 0.1, 1.65),
      createCharacterContent("Bear_Male", "Ayı", "Bear", "Male", false, 110000, 1300, 12, 0.15, 0.08, 0.06, 1.5),
      createCharacterContent("Bear_Female", "Dişi Ayı", "Bear", "Female", false, 130000, 1300, 12, 0.15, 0.08, 0.06, 1.5),
    ],
  };

  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const fileCatalog = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...fallback,
      ...fileCatalog,
      success: true,
      checkedAt: new Date().toISOString(),
      characters: Array.isArray(fileCatalog.characters) ? fileCatalog.characters : fallback.characters,
    };
  } catch (err) {
    console.warn("Character content catalog read failed", err.message);
    return fallback;
  }
}

function getMultiplayerConfig() {
  const port = readIntEnv("FISHNET_PORT", 7770);
  return {
    success: true,
    provider: "fishnet",
    host: process.env.FISHNET_HOST || "91.99.176.77",
    port,
    transport: process.env.FISHNET_TRANSPORT || "tugboat",
    checkedAt: new Date().toISOString(),
  };
}

function createCharacterContent(id, displayName, animalType, gender, starterFree, priceAmount, maxHp, attack, armor, parryChance, critChance, critDamageMultiplier) {
  return {
    id,
    serverId: id,
    displayName,
    animalType,
    gender,
    isEnabled: true,
    isStarterFree: starterFree,
    unlockType: starterFree ? "Default" : "SoftCurrency",
    priceCurrency: starterFree ? "None" : "OzAltin",
    priceAmount,
    sortOrder: getDefaultCharacterSortOrder(id),
    stats: {
      maxHp,
      attack,
      armor,
      parryChance,
      critChance,
      critDamageMultiplier,
    },
    profileModelAddressKey: `${id}_Profile`,
    lobbyModelAddressKey: `${id}_Lobby`,
    battleModelAddressKey: `${id}_Battle`,
  };
}

function getDefaultCharacterSortOrder(id) {
  const order = {
    Tiger_Male: 0,
    Tiger_Female: 1,
    Fox_Male: 2,
    Fox_Female: 3,
    Wolf_Male: 4,
    Wolf_Female: 5,
    Bear_Male: 6,
    Bear_Female: 7,
  };
  return Number.isInteger(order[id]) ? order[id] : 999;
}

function mapUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.account_email || row.email,
    nickname: row.nickname,
    publicPlayerId: row.public_player_id,
    deviceId: row.device_id,
    accountId: row.account_id || 0,
    dynastyName: row.dynasty_name || "",
    dynastyId: row.dynasty_id || "",
    slotIndex: row.slot_index || 1,
    language: row.language,
    age: row.age || 0,
    gender: row.gender || "not_specified",
    avatarId: row.avatar_id || 0,
    profileCompleted: !!row.profile_completed,
    isGuest: !!row.is_guest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProfileSlot(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    slotIndex: row.slot_index || 1,
    nickname: row.nickname,
    publicPlayerId: row.public_player_id,
    age: row.age || 0,
    gender: row.gender || "not_specified",
    avatarId: row.avatar_id || 0,
    profileCompleted: !!row.profile_completed,
    isGuest: !!row.is_guest,
    occupied: true,
    inUseByOtherDevice: !!row.in_use_by_other_device,
    lastActiveAt: row.last_active_at || null,
    updatedAt: row.updated_at,
  };
}

function mapEmptyProfileSlot(slotIndex) {
  return {
    id: 0,
    slotIndex,
    nickname: "",
    publicPlayerId: "",
    age: 0,
    gender: "not_specified",
    avatarId: 0,
    profileCompleted: false,
    isGuest: false,
    occupied: false,
    inUseByOtherDevice: false,
    lastActiveAt: null,
    updatedAt: null,
  };
}

function mapAccount(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    dynastyName: row.dynasty_name,
    dynastyId: row.dynasty_id,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFriendUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    nickname: row.nickname,
    publicPlayerId: row.public_player_id,
    online: !!row.online,
    lastSeenAt: row.last_seen_at,
    isFriend: !!row.is_friend,
    hasPendingOutgoing: !!row.has_pending_outgoing,
    hasPendingIncoming: !!row.has_pending_incoming,
  };
}

function mapRankedPlayer(user, body = {}) {
  return {
    userId: user.id,
    nickname: user.nickname || "Player",
    publicPlayerId: user.public_player_id || "",
    avatarId: Math.max(0, Math.floor(Number(user.avatar_id) || 0)),
    rankTier: normalizeRankTier(body.rankTier),
    rankPoints: clampRankPoints(body.rankPoints),
  };
}

function mapRankedOpponent(player) {
  if (!player) {
    return null;
  }

  return {
    id: String(player.userId),
    displayName: player.nickname || "Player",
    publicPlayerId: player.publicPlayerId || "",
    avatarId: player.avatarId || 0,
    rankTier: player.rankTier || "Unranked",
    rankPoints: player.rankPoints || 0,
  };
}

function mapIncomingRequest(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    senderNickname: row.sender_nickname,
    senderPublicPlayerId: row.sender_public_player_id,
    online: !!row.online,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function mapOutgoingRequest(row) {
  return {
    id: row.id,
    receiverId: row.receiver_id,
    receiverNickname: row.receiver_nickname,
    receiverPublicPlayerId: row.receiver_public_player_id,
    online: !!row.online,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

async function createSession(userId, deviceId) {
  const token = generateToken();
  await pool.query(
    "INSERT INTO user_sessions (user_id, token, device_id) VALUES ($1, $2, $3)",
    [userId, token, deviceId || null]
  );

  if (deviceId) {
    await pool.query(
      `
      INSERT INTO user_devices (user_id, device_id, last_seen_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (device_id) DO UPDATE
      SET user_id = EXCLUDED.user_id, last_seen_at = NOW()
      `,
      [userId, deviceId]
    );
  }

  return token;
}

async function getAccountSlots(accountId, deviceId = "") {
  if (!accountId) {
    return [];
  }

  const cleanDeviceId = normalizeDeviceId(deviceId);
  const result = await pool.query(
    `
    SELECT id, slot_index, nickname, public_player_id, age, gender, avatar_id,
           profile_completed, is_guest, updated_at,
           EXISTS(
             SELECT 1
             FROM user_sessions s
             WHERE s.user_id = users.id
               AND s.last_seen_at >= NOW() - ($2::int * INTERVAL '1 second')
               AND COALESCE(s.device_id, '') <> $3
           ) AS in_use_by_other_device,
           (
             SELECT MAX(s.last_seen_at)
             FROM user_sessions s
             WHERE s.user_id = users.id
           ) AS last_active_at
    FROM users
    WHERE account_id = $1 AND slot_index BETWEEN 1 AND 3
    ORDER BY slot_index ASC
    `,
    [accountId, ONLINE_WINDOW_SECONDS, cleanDeviceId]
  );

  return result.rows.map(mapProfileSlot);
}

async function getAccountSlotOverview(accountId, deviceId = "") {
  const occupied = await getAccountSlots(accountId, deviceId);
  const slots = [mapEmptyProfileSlot(1), mapEmptyProfileSlot(2), mapEmptyProfileSlot(3)];

  for (const slot of occupied) {
    const index = getSlotIndex(slot.slotIndex) - 1;
    slots[index] = { ...slot, occupied: true };
  }

  return slots;
}

async function isProfileInUseByOtherDevice(userId, deviceId = "") {
  if (!userId) {
    return false;
  }

  const cleanDeviceId = normalizeDeviceId(deviceId);
  const result = await pool.query(
    `
    SELECT EXISTS(
      SELECT 1
      FROM user_sessions
      WHERE user_id = $1
        AND last_seen_at >= NOW() - ($2::int * INTERVAL '1 second')
        AND COALESCE(device_id, '') <> $3
    ) AS in_use
    `,
    [userId, ONLINE_WINDOW_SECONDS, cleanDeviceId]
  );

  return !!(result.rows[0] && result.rows[0].in_use);
}

async function getUserByToken(token) {
  if (!token) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT u.*, a.email AS account_email, a.dynasty_name, a.dynasty_id
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN accounts a ON a.id = u.account_id
    WHERE s.token = $1
    `,
    [token]
  );

  if (result.rows.length === 0) {
    return null;
  }

  await pool.query("UPDATE user_sessions SET last_seen_at = NOW() WHERE token = $1", [token]);
  return result.rows[0];
}

async function getUserByDevice(deviceId) {
  if (!deviceId) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT u.*, a.email AS account_email, a.dynasty_name, a.dynasty_id
    FROM user_devices d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN accounts a ON a.id = u.account_id
    WHERE d.device_id = $1
    `,
    [deviceId]
  );

  if (result.rows.length > 0) {
    await pool.query("UPDATE user_devices SET last_seen_at = NOW() WHERE device_id = $1", [deviceId]);
    return result.rows[0];
  }

  const legacy = await pool.query("SELECT * FROM users WHERE device_id = $1", [deviceId]);
  return legacy.rows[0] || null;
}

async function attachDevice(userId, deviceId) {
  if (!deviceId) {
    return;
  }

  await pool.query(
    `
    INSERT INTO user_devices (user_id, device_id, last_seen_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (device_id) DO UPDATE
    SET user_id = EXCLUDED.user_id, last_seen_at = NOW()
    `,
    [userId, deviceId]
  );
}

async function acceptFriendRequest(requestId, receiverId) {
  const params = receiverId ? [requestId, receiverId] : [requestId];
  const receiverClause = receiverId ? "AND receiver_id = $2" : "";
  const requestResult = await pool.query(
    `
    SELECT *
    FROM friend_requests
    WHERE id = $1 AND status = 'pending' ${receiverClause}
    `,
    params
  );

  if (requestResult.rows.length === 0) {
    return null;
  }

  const request = requestResult.rows[0];

  await pool.query(
    "UPDATE friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1",
    [requestId]
  );

  await pool.query(
    "INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [request.sender_id, request.receiver_id]
  );

  await pool.query(
    "INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [request.receiver_id, request.sender_id]
  );

  return request;
}

async function findFriendTargetByNicknameOrId(userId, value) {
  const cleanValue = normalizeLookup(value);
  if (!cleanValue) {
    return null;
  }

  const exactResult = await pool.query(
    `
    SELECT *
    FROM users
    WHERE id <> $1
      AND (
        LOWER(nickname) = LOWER($2)
        OR LOWER(COALESCE(public_player_id, '')) = LOWER($2)
      )
    ORDER BY
      CASE WHEN LOWER(COALESCE(public_player_id, '')) = LOWER($2) THEN 0 ELSE 1 END,
      updated_at DESC NULLS LAST,
      id DESC
    LIMIT 1
    `,
    [userId, cleanValue]
  );

  if (exactResult.rows.length > 0) {
    return exactResult.rows[0];
  }

  const fuzzyResult = await pool.query(
    `
    SELECT *
    FROM users
    WHERE id <> $1 AND nickname ILIKE $2
    ORDER BY
      CASE WHEN nickname ILIKE $3 THEN 0 ELSE 1 END,
      updated_at DESC NULLS LAST,
      nickname ASC
    LIMIT 2
    `,
    [userId, `%${cleanValue}%`, `${cleanValue}%`]
  );

  if (fuzzyResult.rows.length === 1) {
    return fuzzyResult.rows[0];
  }

  return null;
}

function cleanupRankedMatchmaking() {
  const now = Date.now();
  const queueTtlMs = RANKED_QUEUE_TIMEOUT_SECONDS * 1000;
  const matchTtlMs = RANKED_MATCH_TTL_SECONDS * 1000;

  for (const [userId, entry] of rankedQueue.entries()) {
    if (!entry || now - entry.updatedAt > queueTtlMs) {
      rankedQueue.delete(userId);
    }
  }

  for (const [matchId, match] of rankedMatches.entries()) {
    if (!match || now - match.updatedAt > matchTtlMs) {
      rankedMatches.delete(matchId);
    }
  }
}

function findActiveRankedMatchForUser(userId) {
  for (const match of rankedMatches.values()) {
    if (!match || match.finished) {
      continue;
    }

    if (match.playerOne.userId === userId || match.playerTwo.userId === userId) {
      return match;
    }
  }

  return null;
}

function findQueuedRankedOpponent(userId, rankPoints) {
  let best = null;
  let bestDelta = Number.MAX_SAFE_INTEGER;

  for (const entry of rankedQueue.values()) {
    if (!entry || entry.player.userId === userId) {
      continue;
    }

    const delta = Math.abs((entry.player.rankPoints || 0) - rankPoints);
    if (delta < bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }

  return best;
}

function createRankedMatch(playerOne, playerTwo) {
  const match = {
    id: crypto.randomBytes(12).toString("hex"),
    seed: Math.floor(100000 + Math.random() * 900000),
    playerOne,
    playerTwo,
    state: {
      playerOne: createEmptyRankedBoardState(),
      playerTwo: createEmptyRankedBoardState(),
      playerOneHp: 10,
      playerTwoHp: 10,
      maxPlayerOneHp: 10,
      maxPlayerTwoHp: 10,
      damagePerPair: 1,
    },
    events: [],
    nextSeq: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finished: false,
  };

  rankedMatches.set(match.id, match);
  return match;
}

function createEmptyRankedBoardState() {
  return {
    initialized: false,
    tiles: [],
    firstRevealedIndex: -1,
  };
}

function getRankedParticipant(match, userId) {
  if (!match) {
    return null;
  }

  if (match.playerOne.userId === userId) {
    return { index: 1, player: match.playerOne, opponent: match.playerTwo };
  }

  if (match.playerTwo.userId === userId) {
    return { index: 2, player: match.playerTwo, opponent: match.playerOne };
  }

  return null;
}

function createRankedMatchResponse(match, userId) {
  const participant = getRankedParticipant(match, userId);
  if (!participant) {
    return { success: false, error: "Player is not in this match" };
  }

  return {
    success: true,
    matched: true,
    matchId: match.id,
    seed: match.seed,
    playerIndex: participant.index,
    opponent: mapRankedOpponent(participant.opponent),
  };
}

function getRankedBoardState(match, playerIndex) {
  if (!match || !match.state) {
    return null;
  }

  return playerIndex === 1 ? match.state.playerOne : match.state.playerTwo;
}

function getRankedOpponentHpKey(playerIndex) {
  return playerIndex === 1 ? "playerTwoHp" : "playerOneHp";
}

function getRankedMaxOpponentHpKey(playerIndex) {
  return playerIndex === 1 ? "maxPlayerTwoHp" : "maxPlayerOneHp";
}

function normalizeRankedBoardTiles(tiles) {
  if (!Array.isArray(tiles)) {
    return [];
  }

  return tiles.slice(0, 256).map((tile, index) => ({
    index,
    id: String(tile && tile.id ? tile.id : "").slice(0, 64),
    x: Math.floor(Number(tile && tile.x) || 0),
    y: Math.floor(Number(tile && tile.y) || 0),
    z: Math.floor(Number(tile && tile.z) || 0),
    matched: false,
    revealed: false,
  }));
}

function normalizeRankedBoardSlots(slots) {
  if (!Array.isArray(slots)) {
    return [];
  }

  return slots.slice(0, 256).map((slot) => ({
    x: Math.floor(Number(slot && slot.x) || 0),
    y: Math.floor(Number(slot && slot.y) || 0),
    z: Math.floor(Number(slot && slot.z) || 0),
  }));
}

function normalizeRankedTilePool(tilePool) {
  if (!Array.isArray(tilePool)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const item of tilePool) {
    const id = String(item || "").trim().slice(0, 64);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    result.push(id);
  }

  return result;
}

function shuffleWithSeed(list, seed) {
  let state = Math.max(1, Math.floor(Number(seed) || 1)) >>> 0;
  for (let i = list.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
}

function generateRankedBoardTiles(slots, tilePool, seed, actorIndex) {
  const usableCount = slots.length - (slots.length % 2);
  if (usableCount < 2 || tilePool.length === 0) {
    return [];
  }

  const pairIds = [];
  let poolIndex = 0;
  while (pairIds.length < usableCount) {
    const id = tilePool[poolIndex % tilePool.length];
    pairIds.push(id);
    pairIds.push(id);
    poolIndex++;
  }

  pairIds.length = usableCount;
  shuffleWithSeed(pairIds, (seed || 1) + actorIndex * 100003);

  return slots.slice(0, usableCount).map((slot, index) => ({
    index,
    id: pairIds[index],
    x: slot.x,
    y: slot.y,
    z: slot.z,
    matched: false,
    revealed: false,
  }));
}

function isRankedTileActive(tile) {
  return !!tile && !tile.matched;
}

function isRankedTileFree(board, tile) {
  if (!board || !tile || tile.matched) {
    return false;
  }

  for (const other of board.tiles) {
    if (!isRankedTileActive(other) || other.index === tile.index) {
      continue;
    }

    if (other.z === tile.z + 1) {
      const dx = Math.abs(other.x - tile.x);
      const dy = Math.abs(other.y - tile.y);
      if (dx <= 1 && dy <= 1) {
        return false;
      }
    }
  }

  let left = false;
  let right = false;

  for (const other of board.tiles) {
    if (!isRankedTileActive(other) || other.index === tile.index || other.z !== tile.z) {
      continue;
    }

    const dx = other.x - tile.x;
    const dy = Math.abs(other.y - tile.y);
    if (dy !== 0) {
      continue;
    }

    if (dx < 0 && Math.abs(dx) <= 1) {
      left = true;
    }

    if (dx > 0 && dx <= 1) {
      right = true;
    }

    if (left && right) {
      return false;
    }
  }

  return true;
}

function isRankedBoardCleared(board) {
  return !!board && board.tiles.every((tile) => !isRankedTileActive(tile));
}

function pushRankedEvent(match, recipientIndex, payload) {
  const event = {
    seq: match.nextSeq++,
    recipientIndex,
    ...payload,
    createdAt: new Date().toISOString(),
  };

  match.events.push(event);
  if (match.events.length > 500) {
    match.events.splice(0, match.events.length - 500);
  }

  match.updatedAt = Date.now();
  return event;
}

function applyRankedBoardManifest(match, participant, body) {
  const board = getRankedBoardState(match, participant.index);
  if (!board) {
    return { success: false, error: "Board state not found" };
  }

  if (board.initialized) {
    return { success: true, alreadyInitialized: true };
  }

  let tiles = normalizeRankedBoardTiles(body.tiles);
  if (tiles.length === 0) {
    const slots = normalizeRankedBoardSlots(body.slots);
    const tilePool = normalizeRankedTilePool(body.tilePool);
    tiles = generateRankedBoardTiles(slots, tilePool, match.seed, participant.index);
  }

  if (tiles.length < 2) {
    return { success: false, error: "Board manifest is empty" };
  }

  board.tiles = tiles;
  board.firstRevealedIndex = -1;
  board.initialized = true;

  const maxHp = Math.max(1, Math.floor(Number(body.maxHp) || 10));
  const damagePerPair = Math.max(1, Math.floor(Number(body.damagePerPair) || 1));

  if (participant.index === 1) {
    match.state.maxPlayerOneHp = maxHp;
    match.state.playerOneHp = maxHp;
  } else {
    match.state.maxPlayerTwoHp = maxHp;
    match.state.playerTwoHp = maxHp;
  }

  match.state.damagePerPair = Math.max(match.state.damagePerPair || 1, damagePerPair);
  match.updatedAt = Date.now();

  const boardPayload = {
    type: "board",
    actorIndex: participant.index,
    tiles: tiles.map((tile) => ({
      index: tile.index,
      id: tile.id,
      x: tile.x,
      y: tile.y,
      z: tile.z,
    })),
  };

  pushRankedEvent(match, participant.index, boardPayload);
  pushRankedEvent(match, participant.index === 1 ? 2 : 1, boardPayload);

  return { success: true };
}

function applyRankedPick(match, participant, body) {
  const board = getRankedBoardState(match, participant.index);
  if (!board || !board.initialized) {
    return { success: false, error: "Board is not ready" };
  }

  const tileIndex = Math.floor(Number(body.tileIndex));
  const tile = board.tiles[tileIndex];
  if (!tile || tile.matched || tile.revealed) {
    return { success: false, error: "Tile is not available" };
  }

  if (!isRankedTileFree(board, tile)) {
    return { success: false, error: "Tile is blocked" };
  }

  tile.revealed = true;

  pushRankedEvent(match, participant.index, {
    type: "reveal",
    actorIndex: participant.index,
    tileIndex: tile.index,
    tileId: tile.id,
  });

  const opponentIndex = participant.index === 1 ? 2 : 1;
  pushRankedEvent(match, opponentIndex, {
    type: "reveal",
    actorIndex: participant.index,
    tileIndex: tile.index,
    tileId: tile.id,
  });

  if (board.firstRevealedIndex < 0) {
    board.firstRevealedIndex = tile.index;
    return { success: true };
  }

  if (board.firstRevealedIndex === tile.index) {
    return { success: true };
  }

  const first = board.tiles[board.firstRevealedIndex];
  const second = tile;
  const matched = !!first && first.revealed && !first.matched && first.id === second.id;
  board.firstRevealedIndex = -1;

  if (matched) {
    first.matched = true;
    second.matched = true;
    first.revealed = false;
    second.revealed = false;

    pushRankedPairEvents(match, participant.index, first, second, true);
    applyRankedDamage(match, participant.index);

    if (isRankedBoardCleared(board)) {
      pushRankedFinish(match, participant.index);
    }
  } else {
    if (first) {
      first.revealed = false;
    }
    second.revealed = false;
    pushRankedPairEvents(match, participant.index, first, second, false);
  }

  return { success: true };
}

function pushRankedPairEvents(match, actorIndex, first, second, matched) {
  const opponentIndex = actorIndex === 1 ? 2 : 1;
  const payload = {
    type: "pair",
    actorIndex,
    matched,
    firstTileIndex: first ? first.index : -1,
    secondTileIndex: second ? second.index : -1,
    firstTileId: first ? first.id : "",
    secondTileId: second ? second.id : "",
  };

  pushRankedEvent(match, actorIndex, payload);
  pushRankedEvent(match, opponentIndex, payload);
}

function applyRankedDamage(match, actorIndex) {
  const hpKey = getRankedOpponentHpKey(actorIndex);
  const maxHpKey = getRankedMaxOpponentHpKey(actorIndex);
  const opponentIndex = actorIndex === 1 ? 2 : 1;
  const damage = Math.max(1, Math.floor(Number(match.state.damagePerPair) || 1));
  const before = Math.max(0, Math.floor(Number(match.state[hpKey]) || 0));
  const after = Math.max(0, before - damage);
  match.state[hpKey] = after;

  const payload = {
    type: "damage",
    actorIndex,
    targetIndex: opponentIndex,
    amount: damage,
    hpAfter: after,
    maxHp: Math.max(1, Math.floor(Number(match.state[maxHpKey]) || 10)),
  };

  pushRankedEvent(match, actorIndex, payload);
  pushRankedEvent(match, opponentIndex, payload);

  if (after <= 0) {
    pushRankedFinish(match, actorIndex);
  }
}

function pushRankedFinish(match, winnerIndex) {
  if (match.finished) {
    return;
  }

  match.finished = true;
  pushRankedEvent(match, 1, { type: "finish", winnerIndex });
  pushRankedEvent(match, 2, { type: "finish", winnerIndex });
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      dynasty_name VARCHAR(64) NOT NULL,
      dynasty_id VARCHAR(32) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS slot_index INT DEFAULT 1,
      ADD COLUMN IF NOT EXISTS device_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS public_player_id VARCHAR(32),
      ADD COLUMN IF NOT EXISTS language VARCHAR(32) DEFAULT 'turkish',
      ADD COLUMN IF NOT EXISTS age INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS gender VARCHAR(32) DEFAULT 'not_specified',
      ADD COLUMN IF NOT EXISTS avatar_id INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_guest BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
  `);

  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_device_id_unique ON users(device_id) WHERE device_id IS NOT NULL");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_public_player_id_unique ON users(public_player_id) WHERE public_player_id IS NOT NULL");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_account_slot_unique ON users(account_id, slot_index) WHERE account_id IS NOT NULL AND slot_index BETWEEN 1 AND 3");
  await pool.query("CREATE INDEX IF NOT EXISTS users_account_id_idx ON users(account_id)");
  await pool.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_nickname_key");
  await pool.query("DROP INDEX IF EXISTS users_nickname_key");
  await pool.query("CREATE INDEX IF NOT EXISTS users_nickname_idx ON users(nickname)");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(device_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(128) UNIQUE NOT NULL,
      device_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS global_chat_messages (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel VARCHAR(32) NOT NULL DEFAULT 'global',
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query("ALTER TABLE global_chat_messages ADD COLUMN IF NOT EXISTS channel VARCHAR(32) NOT NULL DEFAULT 'global'");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friends (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY(user_id, friend_id)
    )
  `);

  await pool.query("CREATE INDEX IF NOT EXISTS global_chat_messages_created_id_idx ON global_chat_messages(created_at DESC, id DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS global_chat_messages_channel_id_idx ON global_chat_messages(channel, id DESC)");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_unique_pending ON friend_requests(sender_id, receiver_id) WHERE status = 'pending'");
  await pool.query("CREATE INDEX IF NOT EXISTS friend_requests_receiver_status_idx ON friend_requests(receiver_id, status)");
  await pool.query("CREATE INDEX IF NOT EXISTS friends_user_id_idx ON friends(user_id)");

  await applyProfileResetIfNeeded();
}

async function applyProfileResetIfNeeded() {
  if (!PROFILE_RESET_ID) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_maintenance_state (
      key VARCHAR(80) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const resetState = await pool.query(
    "SELECT value FROM app_maintenance_state WHERE key = 'profile_reset_id'"
  );

  if (resetState.rows.length > 0 && resetState.rows[0].value === PROFILE_RESET_ID) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      TRUNCATE TABLE
        friend_requests,
        friends,
        global_chat_messages,
        user_sessions,
        user_devices,
        users,
        accounts
      RESTART IDENTITY CASCADE
    `);
    await seedStartTestAccount(client);
    await client.query(
      `
      INSERT INTO app_maintenance_state (key, value, updated_at)
      VALUES ('profile_reset_id', $1, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = NOW()
      `,
      [PROFILE_RESET_ID]
    );
    await client.query("COMMIT");
    console.log(`Applied profile reset ${PROFILE_RESET_ID}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function seedStartTestAccount(client) {
  const accountResult = await client.query(
    `
    INSERT INTO accounts (dynasty_name, dynasty_id, email, password_hash, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    RETURNING *
    `,
    [
      normalizeDynastyName(SEED_TEST_DYNASTY_NAME),
      SEED_TEST_DYNASTY_ID,
      SEED_TEST_EMAIL,
      hashPassword(SEED_TEST_PASSWORD),
    ]
  );

  const account = accountResult.rows[0];
  const slotEmail = getSlotEmail(account.id, 1);

  await client.query(
    `
    INSERT INTO users (
      account_id, slot_index, email, password, password_hash, nickname,
      public_player_id, language, age, gender, avatar_id,
      profile_completed, is_guest, updated_at
    )
    VALUES ($1, 1, $2, $3, $4, $5, $6, 'turkish', 18, 'not_specified', 0, TRUE, FALSE, NOW())
    `,
    [
      account.id,
      slotEmail,
      SEED_TEST_PASSWORD,
      hashPassword(SEED_TEST_PASSWORD),
      SEED_TEST_NICKNAME,
      SEED_TEST_PUBLIC_PLAYER_ID,
    ]
  );

  console.log(`Seeded start test account ${SEED_TEST_EMAIL}`);
}

ensureSchema()
  .then(() => console.log("Profile schema ready"))
  .catch((err) => console.error("Profile schema failed", err));

app.get("/", (req, res) => {
  res.type("html").send(renderSymbiosisLandingPage());
});

app.get("/download", (req, res) => {
  res.type("html").send(renderSymbiosisLandingPage());
});

app.get("/apk", (req, res) => {
  res.redirect(302, "/downloads/symbiosis-latest.apk");
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      success: true,
      status: "ok",
      database: "ok",
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      status: "error",
      database: "error",
      error: err.message,
      checkedAt: new Date().toISOString(),
    });
  }
});

app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/register", registerDynastyProfile);

app.get("/updates/android", (req, res) => {
  res.json(getAndroidUpdateManifest());
});

app.get("/updates/android/status", (req, res) => {
  res.json(getDownloadsStatus());
});

app.get("/content/characters", (req, res) => {
  res.json(getCharacterContentCatalog());
});

app.get("/multiplayer/config", (req, res) => {
  res.json(getMultiplayerConfig());
});

app.post("/login", async (req, res) => {
  const { email, password, slotIndex } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  try {
    const cleanEmail = String(email).trim().toLowerCase();
    const accountResult = await pool.query(
      "SELECT * FROM accounts WHERE email = $1",
      [cleanEmail]
    );

    const account = accountResult.rows[0];
    if (account) {
      if (!verifyPassword(password, account.password_hash, null)) {
        return res.status(401).json({ success: false, error: "Invalid credentials" });
      }

      const requestedSlot = getSlotIndex(slotIndex);
      const slotResult = await pool.query(
        "SELECT * FROM users WHERE account_id = $1 AND slot_index = $2 AND profile_completed = TRUE",
        [account.id, requestedSlot]
      );

      const user = slotResult.rows[0];
      if (!user) {
        return res.status(404).json({ success: false, error: "Profile slot not found" });
      }

      if (await isProfileInUseByOtherDevice(user.id, req.body.deviceId)) {
        return res.status(409).json({
          success: false,
          error: "Profile is already in use on another device",
          account: mapAccount(account),
          profiles: await getAccountSlotOverview(account.id, req.body.deviceId),
        });
      }

      const token = await createSession(user.id, req.body.deviceId);
      return res.json({
        success: true,
        token,
        user: mapUser({ ...user, account_email: account.email, dynasty_name: account.dynasty_name, dynasty_id: account.dynasty_id }),
        account: mapAccount(account),
        profiles: await getAccountSlotOverview(account.id, req.body.deviceId),
      });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [cleanEmail]
    );

    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash, user.password)) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    const token = await createSession(user.id, req.body.deviceId);
    res.json({ success: true, token, user: mapUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/account/slots", async (req, res) => {
  const { email, password, deviceId } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  try {
    const cleanEmail = String(email).trim().toLowerCase();
    const accountResult = await pool.query(
      "SELECT * FROM accounts WHERE email = $1",
      [cleanEmail]
    );

    const account = accountResult.rows[0];
    if (!account || !verifyPassword(password, account.password_hash, null)) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    res.json({
      success: true,
      account: mapAccount(account),
      profiles: await getAccountSlotOverview(account.id, deviceId),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/account/delete-slot", async (req, res) => {
  const { email, password, slotIndex, deviceId } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  try {
    const cleanEmail = String(email).trim().toLowerCase();
    const accountResult = await pool.query(
      "SELECT * FROM accounts WHERE email = $1",
      [cleanEmail]
    );

    const account = accountResult.rows[0];
    if (!account || !verifyPassword(password, account.password_hash, null)) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    const requestedSlot = getSlotIndex(slotIndex);
    const slotResult = await pool.query(
      "SELECT * FROM users WHERE account_id = $1 AND slot_index = $2 AND profile_completed = TRUE",
      [account.id, requestedSlot]
    );

    const user = slotResult.rows[0];
    if (!user) {
      return res.status(404).json({ success: false, error: "Profile slot not found" });
    }

    if (await isProfileInUseByOtherDevice(user.id, deviceId)) {
      return res.status(409).json({
        success: false,
        error: "Profile is already in use on another device",
        account: mapAccount(account),
        profiles: await getAccountSlotOverview(account.id, deviceId),
      });
    }

    await pool.query("DELETE FROM users WHERE id = $1", [user.id]);

    res.json({
      success: true,
      account: mapAccount(account),
      profiles: await getAccountSlotOverview(account.id, deviceId),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/auth/logout", async (req, res) => {
  const { token } = req.body;

  if (token) {
    await pool.query("DELETE FROM user_sessions WHERE token = $1", [token]);
  }

  res.json({ success: true });
});

app.post("/auth/me", async (req, res) => {
  const user = await getUserByToken(req.body.token);
  if (!user) {
    return res.status(401).json({ success: false, error: "Invalid session" });
  }

  res.json({ success: true, user: mapUser(user) });
});

app.get("/users", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, email, nickname, created_at FROM users ORDER BY id ASC"
    );
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/profile/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "SELECT id, email, nickname, created_at FROM users WHERE id = $1",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/profiles/bootstrap", async (req, res) => {
  const { deviceId, language, token } = req.body;

  if (!deviceId && !token) {
    return res.status(400).json({ success: false, error: "Missing deviceId" });
  }

  const safeDeviceId = deviceId ? String(deviceId).trim() : "";
  if (!safeDeviceId && !token) {
    return res.status(400).json({ success: false, error: "Invalid deviceId" });
  }

  try {
    const sessionUser = await getUserByToken(token);
    if (sessionUser) {
      await attachDevice(sessionUser.id, safeDeviceId);
      const updated = await pool.query(
        "UPDATE users SET language = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
        [sessionUser.id, normalizeLanguage(language)]
      );
      return res.json({ success: true, token, user: mapUser(updated.rows[0]) });
    }

    const existingByDevice = await getUserByDevice(safeDeviceId);
    if (existingByDevice) {
      const updated = await pool.query(
        "UPDATE users SET language = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
        [existingByDevice.id, normalizeLanguage(language)]
      );
      const newToken = await createSession(existingByDevice.id, safeDeviceId);
      return res.json({ success: true, token: newToken, user: mapUser(updated.rows[0]) });
    }

    const password = `device:${safeDeviceId}`;
    let result = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const identity = createGuestIdentity(safeDeviceId);

      try {
        result = await pool.query(
          `
          INSERT INTO users (
            email, password, password_hash, nickname, device_id, public_player_id, language,
            profile_completed, is_guest, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, TRUE, NOW())
          RETURNING *
          `,
          [
            identity.email,
            password,
            hashPassword(password),
            identity.nickname,
            safeDeviceId,
            generatePublicPlayerId(),
            normalizeLanguage(language),
          ]
        );
        break;
      } catch (err) {
        const duplicateKey = err && err.code === "23505";
        if (!duplicateKey || attempt === 4) {
          throw err;
        }
      }
    }

    if (!result || result.rows.length === 0) {
      throw new Error("Guest profile could not be created");
    }

    const newToken = await createSession(result.rows[0].id, safeDeviceId);
    res.json({ success: true, token: newToken, user: mapUser(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function registerDynastyProfile(req, res) {
  const { deviceId, token, dynastyName, slotIndex, email, password, nickname, age, gender, avatarId, language } = req.body;

  if (!nickname) {
    return res.status(400).json({ success: false, error: "Missing account or nickname" });
  }

  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanDynastyName = normalizeDynastyName(dynastyName || nickname || cleanEmail.split("@")[0]);
  if (!cleanDynastyName) {
    return res.status(400).json({ success: false, error: "Dynasty name is required" });
  }

  if (!cleanEmail || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
  }

  try {
    const sessionUser = await getUserByToken(token);
    const deviceUser = await getUserByDevice(deviceId);
    const user = sessionUser || deviceUser;
    const selectedSlot = getSlotIndex(slotIndex);

    let account = null;
    const existingAccount = await pool.query(
      "SELECT * FROM accounts WHERE email = $1",
      [cleanEmail]
    );

    if (existingAccount.rows.length > 0) {
      account = existingAccount.rows[0];
      if (!verifyPassword(password, account.password_hash, null)) {
        return res.status(401).json({ success: false, error: "Invalid credentials for this dynasty account" });
      }

      if (account.dynasty_name !== cleanDynastyName) {
        const updatedAccount = await pool.query(
          "UPDATE accounts SET dynasty_name = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
          [account.id, cleanDynastyName]
        );
        account = updatedAccount.rows[0];
      }
    } else {
      const createdAccount = await pool.query(
        `
        INSERT INTO accounts (dynasty_name, dynasty_id, email, password_hash, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING *
        `,
        [cleanDynastyName, generateDynastyId(cleanDynastyName), cleanEmail, hashPassword(password)]
      );
      account = createdAccount.rows[0];
    }

    const existingSlot = await pool.query(
      "SELECT * FROM users WHERE account_id = $1 AND slot_index = $2",
      [account.id, selectedSlot]
    );

    let targetUser = existingSlot.rows[0] || null;
    const canClaimGuest = !targetUser && user && !user.account_id && !!user.is_guest;
    const slotEmail = getSlotEmail(account.id, selectedSlot);

    if (targetUser || canClaimGuest) {
      const targetUserId = targetUser ? targetUser.id : user.id;
      const result = await pool.query(
        `
        UPDATE users
        SET account_id = $2,
            slot_index = $3,
            email = $4,
            password = $5,
            password_hash = $6,
            nickname = $7,
            age = $8,
            gender = $9,
            avatar_id = $10,
            language = $11,
            profile_completed = TRUE,
            is_guest = FALSE,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [
          targetUserId,
          account.id,
          selectedSlot,
          slotEmail,
          String(password),
          hashPassword(password),
          String(nickname).trim(),
          Math.max(0, Number(age) || 0),
          normalizeGender(gender),
          Math.max(0, Number(avatarId) || 0),
          normalizeLanguage(language),
        ]
      );
      targetUser = result.rows[0];
    } else {
      const result = await pool.query(
        `
        INSERT INTO users (
          account_id, slot_index, email, password, password_hash, nickname,
          public_player_id, language, age, gender, avatar_id,
          profile_completed, is_guest, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, FALSE, NOW())
        RETURNING *
        `,
        [
          account.id,
          selectedSlot,
          slotEmail,
          String(password),
          hashPassword(password),
          String(nickname).trim(),
          generatePublicPlayerId(),
          normalizeLanguage(language),
          Math.max(0, Number(age) || 0),
          normalizeGender(gender),
          Math.max(0, Number(avatarId) || 0),
        ]
      );
      targetUser = result.rows[0];
    }

    const nextToken = await createSession(targetUser.id, deviceId);
    await attachDevice(targetUser.id, deviceId);

    res.json({
      success: true,
      token: nextToken,
      user: mapUser({ ...targetUser, account_email: account.email, dynasty_name: account.dynasty_name, dynasty_id: account.dynasty_id }),
      account: mapAccount(account),
      profiles: await getAccountSlotOverview(account.id, deviceId),
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

app.post("/profiles/register", registerDynastyProfile);
app.post("/profiles/complete", registerDynastyProfile);

app.get("/chat/global", async (req, res) => {
  const token = req.query.token;
  const sinceId = Math.max(0, Number(req.query.sinceId) || 0);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const channel = normalizeChatChannel(req.query.channel);

  try {
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const result = await pool.query(
      `
      SELECT
        m.id,
        m.user_id,
        u.nickname,
        u.public_player_id,
        m.text,
        m.created_at
      FROM global_chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.id > $1 AND m.channel = $3
      ORDER BY m.id DESC
      LIMIT $2
      `,
      [sinceId, limit, channel]
    );

    const messages = result.rows
      .reverse()
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        nickname: row.nickname,
        publicPlayerId: row.public_player_id,
        text: row.text,
        channel,
        createdAt: row.created_at,
      }));

    res.json({ success: true, channel, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/chat/global/send", async (req, res) => {
  const { token, text } = req.body;
  const channel = normalizeChatChannel(req.body.channel);
  const cleanText = String(text || "").trim().replace(/\s+/g, " ");

  if (!cleanText) {
    return res.status(400).json({ success: false, error: "Message is empty" });
  }

  if (cleanText.length > 240) {
    return res.status(400).json({ success: false, error: "Message is too long" });
  }

  try {
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const result = await pool.query(
      `
      INSERT INTO global_chat_messages (user_id, channel, text)
      VALUES ($1, $2, $3)
      RETURNING id, user_id, channel, text, created_at
      `,
      [user.id, channel, cleanText]
    );

    const row = result.rows[0];
    res.json({
      success: true,
      message: {
        id: row.id,
        userId: row.user_id,
        nickname: user.nickname,
        publicPlayerId: user.public_player_id,
        channel: row.channel,
        text: row.text,
        createdAt: row.created_at,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/presence/heartbeat", async (req, res) => {
  try {
    const user = await getUserByToken(req.body.token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    res.json({ success: true, userId: user.id, checkedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/battle/ranked/queue", async (req, res) => {
  try {
    cleanupRankedMatchmaking();

    const user = await getUserByToken(req.body.token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const activeMatch = findActiveRankedMatchForUser(user.id);
    if (activeMatch) {
      return res.json(createRankedMatchResponse(activeMatch, user.id));
    }

    const player = mapRankedPlayer(user, req.body);
    const opponentEntry = findQueuedRankedOpponent(user.id, player.rankPoints);

    if (!opponentEntry) {
      rankedQueue.set(user.id, {
        player,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      return res.json({ success: true, matched: false, status: "waiting" });
    }

    rankedQueue.delete(user.id);
    rankedQueue.delete(opponentEntry.player.userId);

    const match = createRankedMatch(opponentEntry.player, player);
    res.json(createRankedMatchResponse(match, user.id));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/battle/ranked/status", async (req, res) => {
  try {
    cleanupRankedMatchmaking();

    const user = await getUserByToken(req.query.token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const activeMatch = findActiveRankedMatchForUser(user.id);
    if (activeMatch) {
      return res.json(createRankedMatchResponse(activeMatch, user.id));
    }

    const queued = rankedQueue.get(user.id);
    if (queued) {
      queued.updatedAt = Date.now();
      return res.json({ success: true, matched: false, status: "waiting" });
    }

    res.json({ success: true, matched: false, status: "idle" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/battle/ranked/cancel", async (req, res) => {
  try {
    const user = await getUserByToken(req.body.token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    rankedQueue.delete(user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/battle/ranked/version", (req, res) => {
  res.json({
    success: true,
    protocol: "authoritative-server-board-v1",
    authoritative: true,
    serverGeneratesBoard: true,
  });
});

app.post("/battle/ranked/event", async (req, res) => {
  try {
    cleanupRankedMatchmaking();

    const user = await getUserByToken(req.body.token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const match = rankedMatches.get(String(req.body.matchId || ""));
    const participant = getRankedParticipant(match, user.id);
    if (!participant) {
      return res.status(404).json({ success: false, error: "Match not found" });
    }

    const type = String(req.body.type || "").trim();
    if (type === "board") {
      const result = applyRankedBoardManifest(match, participant, req.body);
      if (!result.success) {
        return res.status(400).json(result);
      }

      return res.json({ success: true, authoritative: true });
    }

    if (type === "pick") {
      const result = applyRankedPick(match, participant, req.body);
      if (!result.success) {
        return res.status(400).json(result);
      }

      return res.json({ success: true, authoritative: true });
    }

    if (type !== "tile" && type !== "damage" && type !== "finish") {
      return res.status(400).json({ success: false, error: "Invalid event type" });
    }

    const event = {
      seq: match.nextSeq++,
      senderIndex: participant.index,
      type,
      tileIndex: Math.floor(Number(req.body.tileIndex) || 0),
      tileId: String(req.body.tileId || "").slice(0, 64),
      targetSide: String(req.body.targetSide || "").slice(0, 32),
      amount: Math.max(0, Math.floor(Number(req.body.amount) || 0)),
      createdAt: new Date().toISOString(),
    };

    match.events.push(event);
    if (match.events.length > 500) {
      match.events.splice(0, match.events.length - 500);
    }

    match.updatedAt = Date.now();
    if (type === "finish") {
      pushRankedFinish(match, participant.index);
    }

    res.json({ success: true, seq: event.seq });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/battle/ranked/events", async (req, res) => {
  try {
    cleanupRankedMatchmaking();

    const user = await getUserByToken(req.query.token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const match = rankedMatches.get(String(req.query.matchId || ""));
    const participant = getRankedParticipant(match, user.id);
    if (!participant) {
      return res.status(404).json({ success: false, error: "Match not found" });
    }

    const afterSeq = Math.max(0, Math.floor(Number(req.query.afterSeq) || 0));
    const events = match.events
      .filter((event) => event.seq > afterSeq &&
        (event.recipientIndex === participant.index ||
         (event.recipientIndex == null && event.senderIndex !== participant.index)))
      .slice(0, 100);

    match.updatedAt = Date.now();
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/friends/search", async (req, res) => {
  const token = req.query.token;
  const nickname = normalizeLookup(req.query.nickname);

  if (nickname.length < 2) {
    return res.status(400).json({ success: false, error: "Enter at least 2 characters" });
  }

  try {
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.nickname,
        u.public_player_id,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) AS last_seen_at,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) >= NOW() - ($3::int * INTERVAL '1 second') AS online,
        EXISTS(SELECT 1 FROM friends f WHERE f.user_id = $1 AND f.friend_id = u.id) AS is_friend,
        EXISTS(SELECT 1 FROM friend_requests fr WHERE fr.sender_id = $1 AND fr.receiver_id = u.id AND fr.status = 'pending') AS has_pending_outgoing,
        EXISTS(SELECT 1 FROM friend_requests fr WHERE fr.sender_id = u.id AND fr.receiver_id = $1 AND fr.status = 'pending') AS has_pending_incoming
      FROM users u
      WHERE u.id <> $1 AND u.nickname ILIKE $2
      ORDER BY
        CASE WHEN LOWER(u.nickname) = LOWER($4) THEN 0 ELSE 1 END,
        u.nickname ASC
      LIMIT 10
      `,
      [user.id, `%${nickname}%`, ONLINE_WINDOW_SECONDS, nickname]
    );

    res.json({ success: true, users: result.rows.map(mapFriendUser) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/friends/request-by-nickname", async (req, res) => {
  const { token, nickname } = req.body;
  const cleanNickname = normalizeLookup(nickname);

  if (!cleanNickname) {
    return res.status(400).json({ success: false, error: "Missing nickname" });
  }

  try {
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const target = await findFriendTargetByNicknameOrId(user.id, cleanNickname);
    if (!target) {
      return res.status(404).json({ success: false, error: "Player not found" });
    }

    if (target.id === user.id) {
      return res.status(400).json({ success: false, error: "You cannot add yourself" });
    }

    const friendship = await pool.query(
      "SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2",
      [user.id, target.id]
    );

    if (friendship.rows.length > 0) {
      return res.json({ success: true, message: "Already friends", accepted: true });
    }

    const incoming = await pool.query(
      `
      SELECT id
      FROM friend_requests
      WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1
      `,
      [target.id, user.id]
    );

    if (incoming.rows.length > 0) {
      await acceptFriendRequest(incoming.rows[0].id, user.id);
      return res.json({ success: true, message: "Friend request accepted", accepted: true });
    }

    await pool.query(
      `
      INSERT INTO friend_requests (sender_id, receiver_id, status, updated_at)
      VALUES ($1, $2, 'pending', NOW())
      ON CONFLICT DO NOTHING
      `,
      [user.id, target.id]
    );

    res.json({ success: true, message: "Friend request sent", accepted: false });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/friends/decline", async (req, res) => {
  const { token, requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ success: false, error: "Missing requestId" });
  }

  try {
    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const result = await pool.query(
      `
      UPDATE friend_requests
      SET status = 'declined', updated_at = NOW()
      WHERE id = $1 AND receiver_id = $2 AND status = 'pending'
      RETURNING id
      `,
      [requestId, user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Request not found" });
    }

    res.json({ success: true, message: "Friend request declined" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/friends/list", async (req, res) => {
  try {
    const user = await getUserByToken(req.query.token);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const friendsResult = await pool.query(
      `
      SELECT
        u.id,
        u.nickname,
        u.public_player_id,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) AS last_seen_at,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) >= NOW() - ($2::int * INTERVAL '1 second') AS online,
        TRUE AS is_friend
      FROM friends f
      JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = $1
      ORDER BY online DESC, u.nickname ASC
      `,
      [user.id, ONLINE_WINDOW_SECONDS]
    );

    const incomingResult = await pool.query(
      `
      SELECT
        fr.id,
        fr.sender_id,
        u.nickname AS sender_nickname,
        u.public_player_id AS sender_public_player_id,
        fr.created_at,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) AS last_seen_at,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) >= NOW() - ($2::int * INTERVAL '1 second') AS online
      FROM friend_requests fr
      JOIN users u ON u.id = fr.sender_id
      WHERE fr.receiver_id = $1 AND fr.status = 'pending'
      ORDER BY fr.id ASC
      `,
      [user.id, ONLINE_WINDOW_SECONDS]
    );

    const outgoingResult = await pool.query(
      `
      SELECT
        fr.id,
        fr.receiver_id,
        u.nickname AS receiver_nickname,
        u.public_player_id AS receiver_public_player_id,
        fr.created_at,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) AS last_seen_at,
        GREATEST(
          COALESCE((SELECT MAX(last_seen_at) FROM user_sessions WHERE user_id = u.id), 'epoch'::timestamp),
          COALESCE((SELECT MAX(last_seen_at) FROM user_devices WHERE user_id = u.id), 'epoch'::timestamp)
        ) >= NOW() - ($2::int * INTERVAL '1 second') AS online
      FROM friend_requests fr
      JOIN users u ON u.id = fr.receiver_id
      WHERE fr.sender_id = $1 AND fr.status = 'pending'
      ORDER BY fr.id ASC
      `,
      [user.id, ONLINE_WINDOW_SECONDS]
    );

    res.json({
      success: true,
      friends: friendsResult.rows.map(mapFriendUser),
      incomingRequests: incomingResult.rows.map(mapIncomingRequest),
      outgoingRequests: outgoingResult.rows.map(mapOutgoingRequest),
      onlineWindowSeconds: ONLINE_WINDOW_SECONDS,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SEND FRIEND REQUEST
app.post("/friends/request", async (req, res) => {
  const { senderId, receiverId } = req.body;

  if (!senderId || !receiverId) {
    return res.status(400).json({ success: false, error: "Missing senderId or receiverId" });
  }

  if (senderId === receiverId) {
    return res.status(400).json({ success: false, error: "You cannot add yourself" });
  }

  try {
    await pool.query(
      "INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'pending')",
      [senderId, receiverId]
    );

    res.json({ success: true, message: "Friend request sent" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ACCEPT FRIEND REQUEST
app.post("/friends/accept", async (req, res) => {
  const { token, requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ success: false, error: "Missing requestId" });
  }

  try {
    const user = token ? await getUserByToken(token) : null;
    if (token && !user) {
      return res.status(401).json({ success: false, error: "Invalid session" });
    }

    const request = await acceptFriendRequest(requestId, user ? user.id : null);
    if (!request) {
      return res.status(404).json({ success: false, error: "Request not found" });
    }

    res.json({ success: true, message: "Friend request accepted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// LIST INCOMING REQUESTS
app.get("/friends/requests/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT fr.id, fr.sender_id, u.nickname AS sender_nickname, fr.created_at
      FROM friend_requests fr
      JOIN users u ON u.id = fr.sender_id
      WHERE fr.receiver_id = $1 AND fr.status = 'pending'
      ORDER BY fr.id ASC
      `,
      [userId]
    );

    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// LIST FRIENDS
app.get("/friends/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT f.friend_id AS id, u.nickname, u.email, f.created_at
      FROM friends f
      JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = $1
      ORDER BY f.friend_id ASC
      `,
      [userId]
    );

    res.json({ success: true, friends: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(8080, () => {
  console.log("API running on port 8080");
});

// SEND MESSAGE
app.post("/messages/send", async (req, res) => {
  const { senderId, receiverId, text } = req.body;

  if (!senderId || !receiverId || !text) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3) RETURNING *",
      [senderId, receiverId, text]
    );

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET CHAT BETWEEN TWO USERS
app.get("/messages/:user1/:user2", async (req, res) => {
  const { user1, user2 } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT * FROM messages
      WHERE (sender_id = $1 AND receiver_id = $2)
         OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY id ASC
      `,
      [user1, user2]
    );

    res.json({ success: true, messages: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
