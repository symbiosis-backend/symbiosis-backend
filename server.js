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
app.get("/downloads/symbiosis-latest.apk", (req, res, next) => {
  const apkPath = path.join(__dirname, "downloads", "symbiosis-latest.apk");
  if (fs.existsSync(apkPath)) {
    res.sendFile(apkPath, (err) => {
      if (err) {
        next(err);
      }
    });
    return;
  }

  res.redirect(302, ANDROID_EMBEDDED_APK_URL);
});
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
const ANDROID_EMBEDDED_VERSION_NAME = "1.0.8";
const ANDROID_EMBEDDED_VERSION_CODE = 100008;
const ANDROID_EMBEDDED_APK_URL = "https://dlsymbiosis.com/downloads/symbiosis-latest.apk";
const ANDROID_EMBEDDED_APK_SHA256 = "d6ba7f6885cdabed19d549ab1772571667cce567158817c4bb72b79f0ccc1043";
const ANDROID_EMBEDDED_APK_SIZE_BYTES = 73785894;
const ANDROID_EMBEDDED_RELEASE_NOTES = "Project Chronicles: dynasty vault and bank moved into the central point, while the profile block, vault, and bank now share a stable upper-left anchor.";

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
  if (language === "ru") {
    return "russian";
  }
  if (language === "en") {
    return "english";
  }
  if (language === "tr") {
    return "turkish";
  }
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
    releaseNotes: process.env.ANDROID_RELEASE_NOTES || "Project Chronicles: dynasty vault, bank, and the central point layout are ready.",
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

const SITE_ASSET_BASE_URL = "https://raw.githubusercontent.com/symbiosis-backend/symbiosis-backend/main/downloads";
const SITE_BUTTON_FRAME_URL = "https://raw.githubusercontent.com/symbiosis-backend/symbiosis-backend/b32dc8c16347f7be3e16d12ff6c5574bc1b3d253/downloads/BtnMainStandart.png";

function getSiteAssetUrl(fileName) {
  return `${SITE_ASSET_BASE_URL}/${encodeURIComponent(fileName)}`;
}

function getChangelogEntries() {
  return [
    {
      version: "1.0.8",
      versionCode: 100008,
      date: "2026-04-23",
      title: "The Dynasty and Central Point Chapter",
      summary: "This chapter moved Symbiosis from a set of separate buttons toward a calmer central point. The profile, the dynasty vault, and the bank now live together in the upper-left corner, like the first little administrative district of the account.",
      changes: [
        "Added the dynasty vault as shared storage for gold and amethysts across one account's profiles.",
        "Added a separate bank for exchanging amethysts into gold without touching the vault.",
        "Rebuilt the central point's upper-left UI around one shared anchor layer so profile, vault, and bank stay together."
      ]
    },
    {
      version: "1.0.7",
      versionCode: 100007,
      date: "2026-04-22",
      title: "Project Chronicles",
      summary: "We opened a place where the project can speak about its own making: not only a list of updates, but a running story of how Symbiosis is assembled one system at a time.",
      changes: [
        "New public Chronicles page on dlsymbiosis.com.",
        "New in-game Chronicles button for the main menus and lobbies.",
        "The game reads chronicle entries from the server, with an offline fallback."
      ]
    },
    {
      version: "1.0.6",
      versionCode: 100006,
      date: "2026-04-22",
      title: "Reliable Online Connection",
      summary: "Routed online services through HTTPS on dlsymbiosis.com to improve matchmaking and account access from different networks.",
      changes: [
        "Switched the game client from direct HTTP IP calls to HTTPS domain calls.",
        "Updated the Android APK distribution manifest.",
        "Fixed direct APK download routing."
      ]
    },
    {
      version: "1.0.5",
      versionCode: 100005,
      date: "2026-04-22",
      title: "Online Ranked Matchmaking",
      summary: "Added server-backed ranked battle search with authoritative match state and shared battle board validation.",
      changes: [
        "Players can enter ranked matchmaking and wait for an online opponent.",
        "The server creates ranked matches and generates the battle board.",
        "Tile picks, reveals, damage, and finish events are validated by the server."
      ]
    },
    {
      version: "1.0.4",
      versionCode: 100004,
      date: "2026-04-22",
      title: "Local Wi-Fi Battle",
      summary: "Added local network battles so two devices on the same Wi-Fi can find each other and play.",
      changes: [
        "Created local Wi-Fi room flow.",
        "Added host and join logic for nearby devices.",
        "Improved battle sync for local multiplayer rounds."
      ]
    },
    {
      version: "1.0.3",
      versionCode: 100003,
      date: "2026-04-21",
      title: "Profiles, Friends, and Chat",
      summary: "Expanded account systems so players can keep profile identity and communicate through the server.",
      changes: [
        "Added server profiles and account login flow.",
        "Added friends and requests.",
        "Added global chat support."
      ]
    },
    {
      version: "1.0.2",
      versionCode: 100002,
      date: "2026-04-20",
      title: "Characters and Remote Content",
      summary: "Moved character catalog data toward server-controlled content for easier balancing and updates.",
      changes: [
        "Added remote character catalog endpoint.",
        "Connected battle character data to server content.",
        "Prepared Android addressable content support."
      ]
    },
    {
      version: "1.0.1",
      versionCode: 100001,
      date: "2026-04-20",
      title: "Android Updates",
      summary: "Added APK update metadata and the first website download flow for Android builds.",
      changes: [
        "Added Android update manifest.",
        "Added public APK download page.",
        "Added release notes in the update prompt."
      ]
    },
    {
      version: "1.0.0",
      versionCode: 100000,
      date: "2026-04-20",
      title: "First Public Android Build",
      summary: "Published the first Android build foundation for Symbiosis Mahjong Battle.",
      changes: [
        "Packaged the Android APK.",
        "Prepared the public website entry point.",
        "Started the public build history."
      ]
    }
  ];
}

const CHANGELOG_COPY = {
  en: {
    htmlLang: "en",
    metaDescription: "DLSymbiosis project chronicles and release story.",
    pageTitle: "DLSymbiosis Chronicles",
    homeLabel: "DLSymbiosis home",
    primaryNav: "Primary navigation",
    home: "Home",
    download: "Download",
    account: "Profile",
    downloadLatest: "Download latest APK",
    eyebrow: "Project Chronicles",
    headline: "DLSymbiosis Chronicles",
    lead: "A living story of how we are building Symbiosis: from the first public APK to online battles, dynasty systems, and the small decisions that slowly give the project its shape.",
    latest: "Latest",
    version: "Version",
    footer: "Project chronicles",
    visualAlt: "Gateway to the Universe",
    companyAlt: "Ozkullar Company",
  },
  ru: {
    htmlLang: "ru",
    metaDescription: "Хроники проекта DLSymbiosis и история его сборок.",
    pageTitle: "Хроники DLSymbiosis",
    homeLabel: "Главная DLSymbiosis",
    primaryNav: "Основная навигация",
    home: "Главная",
    download: "Скачать",
    account: "Профиль",
    downloadLatest: "Скачать последнюю APK",
    eyebrow: "Хроники нашего проекта",
    headline: "Хроники DLSymbiosis",
    lead: "Живая повесть о том, как мы собираем Symbiosis: от первой публичной APK до онлайн-боёв, династических систем и маленьких решений, из которых постепенно появляется форма проекта.",
    latest: "Последнее",
    version: "Версия",
    footer: "Хроники проекта",
    visualAlt: "Gateway to the Universe",
    companyAlt: "Ozkullar Company",
  },
  tr: {
    htmlLang: "tr",
    metaDescription: "DLSymbiosis proje kronikleri ve surum hikayesi.",
    pageTitle: "DLSymbiosis Kronikleri",
    homeLabel: "DLSymbiosis ana sayfası",
    primaryNav: "Ana gezinme",
    home: "Ana sayfa",
    download: "İndir",
    account: "Profil",
    downloadLatest: "En yeni APK'yi indir",
    eyebrow: "Proje Kronikleri",
    headline: "DLSymbiosis Kronikleri",
    lead: "Symbiosis'i nasil kurdugumuzu anlatan canli bir hikaye: ilk herkese acik APK'den cevrim ici savaslara, hanedan sistemlerine ve projeye yavas yavas sekil veren kucuk kararlara kadar.",
    latest: "En yeni",
    version: "Sürüm",
    footer: "Proje kronikleri",
    visualAlt: "Gateway to the Universe",
    companyAlt: "Ozkullar Company",
  },
};

const CHANGELOG_ENTRY_COPY = {
  ru: {
    "1.0.8": {
      title: "Глава о династии и центральном пункте",
      summary: "Эта глава перевела Symbiosis от разрозненных кнопок к более спокойному центральному пункту. Профиль, династическое хранилище и банк теперь живут вместе в левом верхнем углу, как первый маленький административный район аккаунта.",
      changes: [
        "Династическое хранилище стало общим складом золота и аметистов для профилей одного аккаунта.",
        "Банк отделён от хранилища и занимается только обменом аметистов на золото.",
        "Левый верхний блок центрального пункта получил общий якорный слой, чтобы профиль, хранилище и банк держались вместе."
      ]
    },
    "1.0.7": {
      title: "Хроники проекта",
      summary: "Мы открыли место, где проект может рассказывать о собственном создании: не просто список обновлений, а продолжающуюся повесть о том, как Symbiosis собирается система за системой.",
      changes: [
        "На dlsymbiosis.com появилась публичная страница хроник.",
        "В игре появилась кнопка хроник для главных меню и лобби.",
        "Игра читает главы хроник с сервера и имеет офлайн-резерв."
      ]
    },
    "1.0.6": {
      title: "Стабильное онлайн-подключение",
      summary: "Онлайн-сервисы переведены на HTTPS через dlsymbiosis.com, чтобы улучшить матчмейкинг и доступ к аккаунтам из разных сетей.",
      changes: [
        "Клиент игры переключён с прямых HTTP IP-запросов на HTTPS-домен.",
        "Обновлён Android-манифест распространения APK.",
        "Исправлена прямая маршрутизация скачивания APK."
      ]
    },
    "1.0.5": {
      title: "Онлайн ranked матчмейкинг",
      summary: "Добавлен серверный поиск ranked-сражений с авторитетным состоянием матча и проверкой общей доски боя.",
      changes: [
        "Игроки могут входить в ranked-поиск и ждать онлайн-соперника.",
        "Сервер создаёт ranked-матчи и генерирует боевую доску.",
        "Выбор плиток, открытия, урон и завершение боя проверяются сервером."
      ]
    },
    "1.0.4": {
      title: "Локальный Wi-Fi бой",
      summary: "Добавлены бои по локальной сети, чтобы два устройства в одной Wi-Fi сети могли находить друг друга и играть.",
      changes: [
        "Создан поток комнат для локального Wi-Fi.",
        "Добавлена логика хоста и подключения для устройств рядом.",
        "Улучшена синхронизация боя для локальных multiplayer-раундов."
      ]
    },
    "1.0.3": {
      title: "Профили, друзья и чат",
      summary: "Расширены системы аккаунтов, чтобы игроки сохраняли профиль и могли общаться через сервер.",
      changes: [
        "Добавлены серверные профили и вход в аккаунт.",
        "Добавлены друзья и заявки.",
        "Добавлена поддержка глобального чата."
      ]
    },
    "1.0.2": {
      title: "Персонажи и удалённый контент",
      summary: "Каталог персонажей перенесён ближе к серверному управлению для более удобного баланса и обновлений.",
      changes: [
        "Добавлен endpoint удалённого каталога персонажей.",
        "Данные боевых персонажей подключены к серверному контенту.",
        "Подготовлена поддержка Android addressable-контента."
      ]
    },
    "1.0.1": {
      title: "Android-обновления",
      summary: "Добавлены APK-метаданные обновлений и первый сценарий скачивания Android-сборок через сайт.",
      changes: [
        "Добавлен Android-манифест обновления.",
        "Добавлена публичная страница скачивания APK.",
        "Добавлены заметки к релизу в окне обновления."
      ]
    },
    "1.0.0": {
      title: "Первая публичная Android-сборка",
      summary: "Опубликована первая основа Android-сборки для Symbiosis Mahjong Battle.",
      changes: [
        "Собрана Android APK.",
        "Подготовлена публичная входная страница сайта.",
        "Начата публичная история сборок."
      ]
    }
  },
  tr: {
    "1.0.8": {
      title: "Hanedan ve Merkez Bolum",
      summary: "Bu bolum Symbiosis'i daginik dugmelerden daha sakin bir merkez bolume tasidi. Profil, hanedan deposu ve banka artik sol ust kosede birlikte duruyor; hesabin ilk kucuk yonetim alani gibi.",
      changes: [
        "Hanedan deposu, ayni hesaptaki profiller icin ortak altin ve ametist birikimi oldu.",
        "Banka depodan ayrildi ve yalnizca ametistleri altina cevirmek icin calisiyor.",
        "Merkez bolumun sol ust blogu tek ortak anchor katmani kullaniyor; profil, depo ve banka birlikte kaliyor."
      ]
    },
    "1.0.7": {
      title: "Proje Kronikleri",
      summary: "Projenin kendi yapilisini anlatabilecegi bir yer actik: yalnizca guncelleme listesi degil, Symbiosis'in sistem sistem nasil kuruldugunu anlatan surekli bir hikaye.",
      changes: [
        "dlsymbiosis.com uzerinde herkese acik Kronikler sayfasi eklendi.",
        "Ana menulere ve lobilere Kronikler dugmesi eklendi.",
        "Oyun kronik bolumlerini sunucudan okur ve cevrim disi yedege sahiptir."
      ]
    },
    "1.0.6": {
      title: "Güvenilir Çevrim İçi Bağlantı",
      summary: "Farklı ağlardan eşleştirme ve hesap erişimini iyileştirmek için çevrim içi servisler dlsymbiosis.com üzerinden HTTPS'e taşındı.",
      changes: [
        "Oyun istemcisi doğrudan HTTP IP çağrılarından HTTPS alan adı çağrılarına geçirildi.",
        "Android APK dağıtım manifesti güncellendi.",
        "Doğrudan APK indirme yönlendirmesi düzeltildi."
      ]
    },
    "1.0.5": {
      title: "Çevrim İçi Ranked Eşleştirme",
      summary: "Sunucu destekli ranked savaş araması, yetkili maç durumu ve ortak savaş tahtası doğrulaması eklendi.",
      changes: [
        "Oyuncular ranked eşleştirmeye girip çevrim içi rakip bekleyebilir.",
        "Sunucu ranked maçları oluşturur ve savaş tahtasını üretir.",
        "Taş seçimleri, açılışlar, hasar ve bitiş olayları sunucu tarafından doğrulanır."
      ]
    },
    "1.0.4": {
      title: "Yerel Wi-Fi Savaşı",
      summary: "Aynı Wi-Fi ağındaki iki cihazın birbirini bulup oynayabilmesi için yerel ağ savaşları eklendi.",
      changes: [
        "Yerel Wi-Fi oda akışı oluşturuldu.",
        "Yakındaki cihazlar için host ve katılma mantığı eklendi.",
        "Yerel multiplayer turları için savaş senkronizasyonu iyileştirildi."
      ]
    },
    "1.0.3": {
      title: "Profiller, Arkadaşlar ve Sohbet",
      summary: "Oyuncuların profil kimliğini koruyup sunucu üzerinden iletişim kurabilmesi için hesap sistemleri genişletildi.",
      changes: [
        "Sunucu profilleri ve hesap giriş akışı eklendi.",
        "Arkadaşlar ve istekler eklendi.",
        "Genel sohbet desteği eklendi."
      ]
    },
    "1.0.2": {
      title: "Karakterler ve Uzak İçerik",
      summary: "Dengeleme ve güncellemeleri kolaylaştırmak için karakter katalog verileri sunucu kontrollü içeriğe taşındı.",
      changes: [
        "Uzak karakter kataloğu endpoint'i eklendi.",
        "Savaş karakter verileri sunucu içeriğine bağlandı.",
        "Android addressable içerik desteği hazırlandı."
      ]
    },
    "1.0.1": {
      title: "Android Güncellemeleri",
      summary: "APK güncelleme metadatası ve Android sürümleri için ilk web sitesi indirme akışı eklendi.",
      changes: [
        "Android güncelleme manifesti eklendi.",
        "Herkese açık APK indirme sayfası eklendi.",
        "Güncelleme penceresine sürüm notları eklendi."
      ]
    },
    "1.0.0": {
      title: "İlk Herkese Açık Android Sürümü",
      summary: "Symbiosis Mahjong Battle için ilk Android sürüm temeli yayınlandı.",
      changes: [
        "Android APK paketlendi.",
        "Herkese açık web sitesi giriş noktası hazırlandı.",
        "Herkese açık sürüm geçmişi başlatıldı."
      ]
    }
  }
};

function getLocalizedChangelogEntries(locale) {
  const translations = CHANGELOG_ENTRY_COPY[locale] || {};
  return getChangelogEntries().map((entry) => ({
    ...entry,
    ...(translations[entry.version] || {}),
  }));
}

function renderChangelogEntry(entry, copy) {
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  return `<article class="timeline-item">
    <div class="timeline-meta">
      <span class="pill">${escapeHtml(copy.version)} ${escapeHtml(entry.version)}</span>
      <span class="date">${escapeHtml(entry.date)}</span>
    </div>
    <h3>${escapeHtml(entry.title)}</h3>
    <p>${escapeHtml(entry.summary)}</p>
    <ul>${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>
  </article>`;
}

function renderChangelogPage(req) {
  const locale = getLandingLocale(req);
  const copy = CHANGELOG_COPY[locale] || CHANGELOG_COPY.en;
  const entries = getLocalizedChangelogEntries(locale);
  const latest = entries[0];
  const logoUrl = getSiteAssetUrl("SymbiosisLogo.png");
  const sloganUrl = getSiteAssetUrl("Slogan.png");
  const companyUrl = getSiteAssetUrl("OzkullarCompany.png");
  const buttonUrl = SITE_BUTTON_FRAME_URL;

  return `<!doctype html>
<html lang="${escapeHtml(copy.htmlLang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b1014">
  <meta name="description" content="${escapeHtml(copy.metaDescription)}">
  <meta property="og:image" content="${escapeHtml(logoUrl)}">
  <link rel="icon" type="image/png" href="${escapeHtml(logoUrl)}">
  <title>${escapeHtml(copy.pageTitle)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #00020b;
      --ink: #f4f8ff;
      --muted: #aab8cc;
      --line: rgba(149,194,255,.24);
      --panel: #06101d;
      --gold: #8cc8ff;
      --jade: #62d8ff;
      --button-img: url("${escapeHtml(buttonUrl)}");
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      min-height: 100vh;
    }
    a { color: inherit; }
    .shell { width: min(1040px, calc(100% - 32px)); margin: 0 auto; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(12,15,18,.88);
      border-bottom: 1px solid var(--line);
    }
    .nav {
      min-height: 64px;
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
      font-weight: 800;
    }
    .brand img {
      display: block;
      width: min(190px, 42vw);
      height: auto;
    }
    .nav-right {
      display: flex;
      align-items: center;
      gap: 22px;
    }
    .navlinks {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    .navlinks a {
      min-height: 42px;
      padding: 0 18px;
      border: 1px solid rgba(140,200,255,.42);
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      white-space: nowrap;
      font-weight: 800;
      color: #eaf6ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.10), rgba(2,10,24,.42)),
        var(--button-img) center / 100% 100% no-repeat;
      box-shadow: inset 0 0 18px rgba(98,216,255,.12), 0 0 18px rgba(33,89,161,.12);
      text-shadow: 0 1px 0 #000;
    }
    .navlinks a:hover {
      color: #ffffff;
      border-color: rgba(174,220,255,.72);
      filter: brightness(1.13);
    }
    .lang-switch {
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid rgba(140,200,255,.34);
      border-radius: 10px;
      padding: 4px;
    }
    .lang-switch a {
      min-width: 34px;
      min-height: 30px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      text-decoration: none;
      font-size: 12px;
      font-weight: 800;
    }
    .lang-switch a.active {
      color: #001020;
      background: linear-gradient(180deg, #dff5ff, #62d8ff);
    }
    .hero {
      padding: 72px 0 42px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 48px;
      align-items: center;
    }
    .eyebrow {
      color: var(--gold);
      font-weight: 750;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 12px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: clamp(42px, 8vw, 78px);
      line-height: .94;
      letter-spacing: 0;
    }
    .brand-art {
      display: grid;
      gap: 18px;
    }
    .brand-art img {
      display: block;
      width: 100%;
      height: auto;
    }
    .lead {
      max-width: 720px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: 20px;
      line-height: 1.56;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 28px;
    }
    .button {
      min-height: 56px;
      padding: 0 22px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      font-weight: 800;
      border: 1px solid var(--line);
      background: rgba(12,31,58,.48);
    }
    .button.primary {
      color: #f4f8ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.12), rgba(2,10,24,.54)),
        var(--button-img) center / 100% 100% no-repeat;
      border-color: rgba(140,200,255,.44);
      text-shadow: 0 1px 0 #000;
      box-shadow: inset 0 0 20px rgba(98,216,255,.12), 0 0 24px rgba(33,89,161,.14);
    }
    .timeline {
      padding: 22px 0 76px;
      display: grid;
      gap: 16px;
    }
    .timeline-item {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 24px;
    }
    .timeline-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .pill {
      border: 1px solid var(--line);
      background: rgba(255,255,255,.045);
      border-radius: 999px;
      padding: 8px 12px;
      color: var(--jade);
      font-weight: 800;
    }
    .date { color: var(--muted); }
    h3 {
      margin: 0;
      font-size: 26px;
      letter-spacing: 0;
    }
    p {
      color: var(--muted);
      line-height: 1.58;
      margin: 12px 0 0;
    }
    ul {
      margin: 16px 0 0;
      padding-left: 22px;
      color: var(--muted);
      line-height: 1.7;
    }
    li::marker { color: var(--gold); }
    footer {
      padding: 28px 0 42px;
      color: var(--muted);
      border-top: 1px solid var(--line);
      font-size: 14px;
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 22px, 1040px); }
      .hero { grid-template-columns: 1fr; padding-top: 46px; }
      .button { width: 100%; }
      .nav { align-items: flex-start; flex-direction: column; padding: 12px 0; }
      .nav-right { width: 100%; justify-content: space-between; gap: 12px; }
      .navlinks { flex-wrap: wrap; gap: 8px; }
      .navlinks a { min-height: 38px; padding: 0 14px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <a class="brand" href="${escapeHtml(withLangPath("/", locale))}" aria-label="${escapeHtml(copy.homeLabel)}">
        <img src="${escapeHtml(logoUrl)}" alt="DLSymbiosis" width="1187" height="188">
      </a>
      <div class="nav-right">
        <nav class="navlinks" aria-label="${escapeHtml(copy.primaryNav)}">
          <a href="${escapeHtml(withLangPath("/", locale))}">${escapeHtml(copy.home)}</a>
          <a href="${escapeHtml(withLangPath("/download", locale))}">${escapeHtml(copy.download)}</a>
          <a href="${escapeHtml(withLangPath("/dynasty-legacy", locale))}">Dynasty: Legacy</a>
          <a href="${escapeHtml(withLangPath("/account", locale))}">${escapeHtml(copy.account)}</a>
        </nav>
        <nav class="lang-switch" aria-label="Language">
          <a class="${locale === "en" ? "active" : ""}" href="/changelog?lang=en" lang="en">EN</a>
          <a class="${locale === "ru" ? "active" : ""}" href="/changelog?lang=ru" lang="ru">RU</a>
          <a class="${locale === "tr" ? "active" : ""}" href="/changelog?lang=tr" lang="tr">TR</a>
        </nav>
      </div>
    </div>
  </header>
  <main>
    <section class="shell hero">
      <div>
        <div class="eyebrow">${escapeHtml(copy.eyebrow)}</div>
        <h1>${escapeHtml(copy.headline)}</h1>
        <p class="lead">${escapeHtml(copy.lead)}</p>
        <div class="actions">
          <a class="button primary" href="${escapeHtml(withLangPath("/download", locale))}">${escapeHtml(copy.downloadLatest)}</a>
        </div>
        <p class="lead">${escapeHtml(copy.latest)}: ${escapeHtml(latest.version)} - ${escapeHtml(latest.title)}</p>
      </div>
      <div class="brand-art" aria-label="DLSymbiosis artwork">
        <img src="${escapeHtml(sloganUrl)}" alt="${escapeHtml(copy.visualAlt)}" width="951" height="303">
        <img src="${escapeHtml(companyUrl)}" alt="${escapeHtml(copy.companyAlt)}" width="1047" height="312">
      </div>
    </section>
    <section class="shell timeline">
      ${entries.map((entry) => renderChangelogEntry(entry, copy)).join("")}
    </section>
  </main>
  <footer>
    <div class="shell">(c) ${new Date().getFullYear()} DLSymbiosis / ${escapeHtml(copy.footer)}</div>
  </footer>
</body>
</html>`;
}

function renderAndroidDownloadPage() {
  const manifest = getAndroidUpdateManifest();
  const baseUrl = getPublicBaseUrl();
  const apkUrl = manifest.apkUrl || manifest.updateUrl || `${baseUrl}/downloads/symbiosis-latest.apk`;
  const versionName = manifest.versionName || manifest.latestVersion || "latest";
  const versionCode = manifest.versionCode || manifest.latestVersionCode || "";
  const sizeBytes = manifest.sizeBytes || manifest.apkSizeBytes || 0;
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

function getLandingLocale(req) {
  const requested = String((req && req.query && req.query.lang) || "").trim().toLowerCase();
  if (["en", "ru", "tr"].includes(requested)) {
    return requested;
  }

  const acceptLanguage = String((req && req.headers && req.headers["accept-language"]) || "").toLowerCase();
  if (acceptLanguage.includes("ru")) {
    return "ru";
  }
  if (acceptLanguage.includes("tr")) {
    return "tr";
  }
  return "en";
}

const LANDING_COPY = {
  en: {
    htmlLang: "en",
    pageTitle: "DLSymbiosis - Mahjong Battle",
    metaDescription: "Download DLSymbiosis, a Mahjong Battle game for Android with online profiles and local Wi-Fi duels.",
    ogDescription: "Mahjong Battle for Android. Download the latest APK.",
    homeLabel: "DLSymbiosis home",
    primaryNav: "Primary navigation",
    download: "Download",
    updates: "Chronicles",
    account: "Profile",
    contact: "Contact",
    eyebrow: "Mahjong Battle for Android",
    lead: "A fast Mahjong battle game for Android. Download the current APK, install it, and play with your profile online or over local Wi-Fi.",
    downloadApk: "Download APK",
    version: "Version",
    updated: "Updated",
    latestBuild: "Latest build",
    buildLabel: "Latest Android build",
    releaseNotes: "Project Chronicles: dynasty vault and bank moved into the central point, while the profile block now shares a stable anchor layer with them.",
    platform: "Platform",
    androidApk: "Android APK",
    mode: "Mode",
    onlineWifi: "Online / Wi-Fi",
    support: "Support",
    creditsLabel: "Project credits",
    creditsTitle: "Development and art",
    creditsText: "DLSymbiosis is built for Dynasty Legacy, with development and construction by BlackYang and art and design by WhiteYin.",
    creatorsHeadline: "Built by two creators",
    creatorsText: "A focused two-person project: BlackYang shapes the systems, construction, and release flow; WhiteYin gives the world its visual identity.",
    blackYangRole: "Development and construction",
    whiteYinRole: "Art and design",
    madeForAlt: "Made for Dynasty Legacy",
    devAlt: "Development and construction by BlackYang. Art and design by WhiteYin.",
  },
  ru: {
    htmlLang: "ru",
    pageTitle: "DLSymbiosis - маджонг-бои",
    metaDescription: "Скачайте DLSymbiosis, игру с маджонг-боями для Android, онлайн-профилями и дуэлями по локальной Wi-Fi сети.",
    ogDescription: "Маджонг-бои для Android. Скачайте последнюю APK-сборку.",
    homeLabel: "Главная DLSymbiosis",
    primaryNav: "Основная навигация",
    download: "Скачать",
    updates: "Хроники",
    account: "Профиль",
    contact: "Контакты",
    eyebrow: "Боевая маджонг-игра для Android",
    lead: "Быстрая игра с маджонг-боями для Android. Скачайте актуальную APK, установите её и играйте с профилем онлайн или по локальной Wi-Fi сети.",
    downloadApk: "Скачать APK",
    version: "Версия",
    updated: "Обновлено",
    latestBuild: "Последняя сборка",
    buildLabel: "Последняя Android-сборка",
    releaseNotes: "Хроники нашего проекта: династическое хранилище и банк пришли в центральный пункт, а профильный блок получил общий стабильный якорь.",
    platform: "Платформа",
    androidApk: "APK для Android",
    mode: "Режим",
    onlineWifi: "Онлайн / локальный Wi-Fi",
    support: "Поддержка",
    creditsLabel: "Авторы проекта",
    creditsTitle: "Разработка и арт",
    creditsText: "DLSymbiosis создана для Dynasty Legacy. Разработка и конструкция: BlackYang. Арт и дизайн: WhiteYin.",
    creatorsHeadline: "Проект создают два автора",
    creatorsText: "Это сфокусированный проект двух людей: BlackYang собирает системы, архитектуру и релизный поток, а WhiteYin формирует визуальный стиль мира.",
    blackYangRole: "Разработка и конструкция",
    whiteYinRole: "Арт и дизайн",
    madeForAlt: "Создано для Dynasty Legacy",
    devAlt: "Разработка и конструкция: BlackYang. Арт и дизайн: WhiteYin.",
  },
  tr: {
    htmlLang: "tr",
    pageTitle: "DLSymbiosis - mahjong savaşları",
    metaDescription: "DLSymbiosis'i indirin: Android için çevrim içi profiller ve yerel Wi-Fi düelloları olan bir mahjong savaş oyunu.",
    ogDescription: "Android için mahjong savaşları. En yeni APK'yi indirin.",
    homeLabel: "DLSymbiosis ana sayfası",
    primaryNav: "Ana gezinme",
    download: "İndir",
    updates: "Kronikler",
    account: "Profil",
    contact: "İletişim",
    eyebrow: "Android için Mahjong savaş oyunu",
    lead: "Android için hızlı bir mahjong savaş oyunu. Güncel APK'yi indirin, kurun ve profilinizle çevrim içi ya da yerel Wi-Fi üzerinden oynayın.",
    downloadApk: "APK indir",
    version: "Sürüm",
    updated: "Güncellendi",
    latestBuild: "Son sürüm",
    buildLabel: "Son Android sürümü",
    releaseNotes: "Proje Kronikleri: hanedan deposu ve banka merkez bolume tasindi, profil blogu onlarla ayni sabit anchor katmanini paylasiyor.",
    platform: "Platform",
    androidApk: "Android APK",
    mode: "Mod",
    onlineWifi: "Çevrim içi / Wi-Fi",
    support: "Destek",
    creditsLabel: "Proje ekibi",
    creditsTitle: "Geliştirme ve sanat",
    creditsText: "DLSymbiosis, Dynasty Legacy için hazırlandı. Geliştirme ve kurulum BlackYang, sanat ve tasarım WhiteYin tarafından yapıldı.",
    creatorsHeadline: "İki yaratıcı tarafından geliştiriliyor",
    creatorsText: "Odaklı iki kişilik bir proje: BlackYang sistemleri, yapıyı ve yayın akışını kurar; WhiteYin dünyaya görsel kimliğini verir.",
    blackYangRole: "Geliştirme ve kurulum",
    whiteYinRole: "Sanat ve tasarım",
    madeForAlt: "Dynasty Legacy için yapıldı",
    devAlt: "Geliştirme ve kurulum BlackYang. Sanat ve tasarım WhiteYin.",
  },
};

function withLangPath(path, lang) {
  return `${path}?lang=${encodeURIComponent(lang)}`;
}

function renderSymbiosisLandingPage(req) {
  const manifest = getAndroidUpdateManifest();
  const baseUrl = getPublicBaseUrl();
  const apkUrl = manifest.apkUrl || manifest.updateUrl || `${baseUrl}/downloads/symbiosis-latest.apk`;
  const versionName = manifest.versionName || manifest.latestVersion || "latest";
  const versionCode = manifest.versionCode || manifest.latestVersionCode || "";
  const sizeBytes = manifest.sizeBytes || manifest.apkSizeBytes || 0;
  const updatedAt = manifest.updatedAt || manifest.checkedAt || new Date().toISOString();
  const supportEmail = "support@dlsymbiosis.com";
  const locale = getLandingLocale(req);
  const copy = LANDING_COPY[locale] || LANDING_COPY.en;
  const logoUrl = getSiteAssetUrl("SymbiosisLogo.png");
  const devCreditUrl = getSiteAssetUrl("DevelopmentAndDesign.png");
  const madeForUrl = getSiteAssetUrl("MadeForDynastyLegacy.png");
  const buttonUrl = SITE_BUTTON_FRAME_URL;

  return `<!doctype html>
<html lang="${escapeHtml(copy.htmlLang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b1014">
  <meta name="description" content="${escapeHtml(copy.metaDescription)}">
  <meta property="og:title" content="${escapeHtml(copy.pageTitle)}">
  <meta property="og:description" content="${escapeHtml(copy.ogDescription)}">
  <meta property="og:image" content="${escapeHtml(logoUrl)}">
  <link rel="icon" type="image/png" href="${escapeHtml(logoUrl)}">
  <title>${escapeHtml(copy.pageTitle)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #00020b;
      --ink: #f4f8ff;
      --muted: #aab8cc;
      --line: rgba(149,194,255,.24);
      --panel: #06101d;
      --gold: #8cc8ff;
      --jade: #62d8ff;
      --button-img: url("${escapeHtml(buttonUrl)}");
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      min-height: 100vh;
    }
    a { color: inherit; }
    .shell { width: min(1040px, calc(100% - 32px)); margin: 0 auto; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(12,15,18,.88);
      border-bottom: 1px solid var(--line);
    }
    .nav {
      min-height: 64px;
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
      font-weight: 800;
    }
    .brand img {
      display: block;
      width: min(190px, 42vw);
      height: auto;
    }
    .nav-right {
      display: flex;
      align-items: center;
      gap: 22px;
    }
    .navlinks {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    .navlinks a {
      min-height: 42px;
      padding: 0 18px;
      border: 1px solid rgba(140,200,255,.42);
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      white-space: nowrap;
      font-weight: 800;
      color: #eaf6ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.10), rgba(2,10,24,.42)),
        var(--button-img) center / 100% 100% no-repeat;
      box-shadow: inset 0 0 18px rgba(98,216,255,.12), 0 0 18px rgba(33,89,161,.12);
      text-shadow: 0 1px 0 #000;
    }
    .navlinks a:hover {
      color: #ffffff;
      border-color: rgba(174,220,255,.72);
      filter: brightness(1.13);
    }
    .lang-switch {
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid rgba(140,200,255,.34);
      border-radius: 10px;
      padding: 4px;
    }
    .lang-switch a {
      min-width: 34px;
      min-height: 30px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      text-decoration: none;
      font-size: 12px;
      font-weight: 800;
    }
    .lang-switch a.active {
      color: #001020;
      background: linear-gradient(180deg, #dff5ff, #62d8ff);
    }
    .hero {
      min-height: calc(100vh - 64px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      align-items: center;
      gap: 56px;
      padding: 80px 0 72px;
    }
    .eyebrow {
      color: var(--gold);
      font-weight: 750;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 12px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0;
      max-width: 700px;
      font-size: clamp(44px, 7vw, 86px);
      line-height: .95;
      letter-spacing: 0;
    }
    .hero-logo {
      display: block;
      width: min(620px, 100%);
      height: auto;
      margin: 0 0 24px;
    }
    .lead {
      max-width: 580px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: clamp(18px, 2vw, 21px);
      line-height: 1.5;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 32px;
    }
    .button {
      min-height: 50px;
      padding: 0 20px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      font-weight: 800;
      border: 1px solid var(--line);
    }
    .button.primary {
      color: #f4f8ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.12), rgba(2,10,24,.54)),
        var(--button-img) center / 100% 100% no-repeat;
      border-color: rgba(140,200,255,.44);
      text-shadow: 0 1px 0 #000;
      box-shadow: inset 0 0 20px rgba(98,216,255,.12), 0 0 24px rgba(33,89,161,.14);
    }
    .button.secondary {
      color: var(--ink);
      background: transparent;
    }
    .version {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 24px;
      color: var(--muted);
      font-size: 14px;
    }
    .version span + span::before {
      content: "/";
      color: rgba(255,255,255,.28);
      margin-right: 14px;
    }
    .download-card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 26px;
    }
    .credit-art {
      display: grid;
      gap: 14px;
      margin-bottom: 24px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background:
        linear-gradient(135deg, rgba(98,216,255,.13), rgba(37,87,156,.12)),
        rgba(255,255,255,.025);
    }
    .credit-art img {
      display: block;
      width: 100%;
      height: auto;
    }
    .credit-art .made-for {
      padding: 4px 0;
    }
    .download-card h2 {
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
    }
    .download-card h3 {
      margin: 24px 0 0;
      color: var(--gold);
      font-size: 12px;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .download-card p {
      margin: 14px 0 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .creator-showcase {
      margin-top: 24px;
      padding-top: 22px;
      border-top: 1px solid var(--line);
    }
    .creator-showcase h3 {
      margin-top: 0;
    }
    .creator-showcase .creator-title {
      margin: 8px 0 0;
      color: var(--ink);
      font-size: 21px;
      font-weight: 850;
      line-height: 1.2;
    }
    .creator-showcase .creator-text {
      margin: 12px 0 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .creator-duo {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 16px;
    }
    .creator-card {
      min-height: 104px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: rgba(255,255,255,.035);
      display: grid;
      align-content: center;
      gap: 8px;
    }
    .creator-card strong {
      color: var(--ink);
      font-size: 19px;
      line-height: 1.1;
    }
    .creator-card span {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }
    .creator-card:first-child {
      border-color: rgba(217,173,103,.42);
    }
    .creator-card:last-child {
      border-color: rgba(111,198,174,.38);
    }
    .creator-signature {
      display: block;
      width: 100%;
      height: auto;
      margin-top: 18px;
      opacity: .92;
    }
    .build-list {
      margin: 22px 0;
      display: grid;
      gap: 12px;
      font-size: 14px;
      color: var(--muted);
    }
    .build-list div {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 12px;
    }
    .build-list strong {
      color: var(--ink);
      font-weight: 750;
    }
    .direct {
      display: block;
      margin-top: 18px;
      color: var(--jade);
      overflow-wrap: anywhere;
      text-decoration: none;
      line-height: 1.45;
      font-size: 13px;
    }
    .direct:hover { text-decoration: underline; }
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
      .hero {
        grid-template-columns: 1fr;
        min-height: 0;
        padding-top: 54px;
      }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 22px, 1040px); }
      .nav { align-items: flex-start; flex-direction: column; padding: 12px 0; }
      .nav-right { width: 100%; justify-content: space-between; gap: 12px; }
      .navlinks { flex-wrap: wrap; gap: 8px; }
      .navlinks a { min-height: 38px; padding: 0 14px; }
      .button { width: 100%; }
      .creator-duo { grid-template-columns: 1fr; }
      .build-list div { display: grid; gap: 4px; }
      .version span + span::before { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <a class="brand" href="${escapeHtml(withLangPath("/", locale))}" aria-label="${escapeHtml(copy.homeLabel)}">
        <img src="${escapeHtml(logoUrl)}" alt="DLSymbiosis" width="1187" height="188">
      </a>
      <div class="nav-right">
        <nav class="navlinks" aria-label="${escapeHtml(copy.primaryNav)}">
          <a href="${escapeHtml(apkUrl)}">${escapeHtml(copy.download)}</a>
          <a href="${escapeHtml(withLangPath("/dynasty-legacy", locale))}">Dynasty: Legacy</a>
          <a href="${escapeHtml(withLangPath("/changelog", locale))}">${escapeHtml(copy.updates)}</a>
          <a href="${escapeHtml(withLangPath("/account", locale))}">${escapeHtml(copy.account)}</a>
          <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(copy.contact)}</a>
        </nav>
        <nav class="lang-switch" aria-label="Language">
          <a class="${locale === "en" ? "active" : ""}" href="/?lang=en" lang="en">EN</a>
          <a class="${locale === "ru" ? "active" : ""}" href="/?lang=ru" lang="ru">RU</a>
          <a class="${locale === "tr" ? "active" : ""}" href="/?lang=tr" lang="tr">TR</a>
        </nav>
      </div>
    </div>
  </header>
  <main id="top">
    <section class="shell hero">
      <div>
        <div class="eyebrow">${escapeHtml(copy.eyebrow)}</div>
        <img class="hero-logo" src="${escapeHtml(logoUrl)}" alt="DLSymbiosis" width="1187" height="188">
        <p class="lead">${escapeHtml(copy.lead)}</p>
        <div class="actions">
          <a class="button primary" href="${escapeHtml(apkUrl)}">${escapeHtml(copy.downloadApk)}</a>
          <a class="button secondary" href="${escapeHtml(withLangPath("/changelog", locale))}">${escapeHtml(copy.updates)}</a>
        </div>
        <div class="version">
          <span>${escapeHtml(copy.version)} ${escapeHtml(versionName)}${versionCode ? ` (${escapeHtml(versionCode)})` : ""}</span>
          <span>${escapeHtml(formatBytes(sizeBytes))}</span>
          <span>${escapeHtml(copy.updated)} ${escapeHtml(new Date(updatedAt).toLocaleDateString(copy.htmlLang))}</span>
        </div>
      </div>
      <aside class="download-card" aria-label="${escapeHtml(copy.buildLabel)}">
        <div class="credit-art">
          <img class="made-for" src="${escapeHtml(madeForUrl)}" alt="${escapeHtml(copy.madeForAlt)}" width="1260" height="264">
        </div>
        <h2>${escapeHtml(copy.latestBuild)}</h2>
        <p>${escapeHtml(copy.releaseNotes)}</p>
        <div class="build-list">
          <div>
            <span>${escapeHtml(copy.platform)}</span>
            <strong>${escapeHtml(copy.androidApk)}</strong>
          </div>
          <div>
            <span>${escapeHtml(copy.mode)}</span>
            <strong>${escapeHtml(copy.onlineWifi)}</strong>
          </div>
          <div>
            <span>${escapeHtml(copy.support)}</span>
            <strong>${escapeHtml(supportEmail)}</strong>
          </div>
        </div>
        <a class="button primary" href="${escapeHtml(apkUrl)}">${escapeHtml(copy.downloadApk)}</a>
        <section class="creator-showcase" aria-label="${escapeHtml(copy.creditsLabel)}">
          <h3>${escapeHtml(copy.creditsLabel)}</h3>
          <div class="creator-title">${escapeHtml(copy.creatorsHeadline)}</div>
          <p class="creator-text">${escapeHtml(copy.creatorsText)}</p>
          <div class="creator-duo">
            <div class="creator-card">
              <strong>BlackYang</strong>
              <span>${escapeHtml(copy.blackYangRole)}</span>
            </div>
            <div class="creator-card">
              <strong>WhiteYin</strong>
              <span>${escapeHtml(copy.whiteYinRole)}</span>
            </div>
          </div>
          <img class="creator-signature" src="${escapeHtml(devCreditUrl)}" alt="${escapeHtml(copy.devAlt)}" width="1173" height="489">
        </section>
      </aside>
    </section>
  </main>
  <footer>
    <div class="shell">
      <span>(c) ${new Date().getFullYear()} DLSymbiosis</span>
      <span><a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></span>
    </div>
  </footer>
</body>
</html>`;
}

const FLAGSHIP_COPY = {
  en: {
    htmlLang: "en",
    pageTitle: "Dynasty: Legacy | DLSymbiosis",
    metaDescription: "Discover Dynasty: Legacy, the flagship social city-building project behind DLSymbiosis.",
    ogDescription: "A flagship social city-builder shaped by coordinated player cooperation in an open world.",
    homeLabel: "DLSymbiosis home",
    primaryNav: "Primary navigation",
    home: "Home",
    download: "Download",
    updates: "Chronicles",
    account: "Profile",
    contact: "Contact",
    flagship: "Dynasty: Legacy",
    eyebrow: "Flagship Project",
    headline: "Dynasty: Legacy",
    lead: "Dynasty: Legacy is our flagship social city-building project: an open world designed to strengthen society through coordinated, cooperative work. It is built around shared responsibility, collective construction, and the idea that a world becomes meaningful when its people shape it together.",
    summaryTitle: "A world built by its own people",
    summaryText: "This is not a decorative backdrop. It is a living space players will inhabit, develop, organize, and transform over time. Cities, districts, rhythms of growth, and the character of the environment are meant to emerge from player action itself.",
    pillarOneTitle: "Social foundation",
    pillarOneText: "At its core, Dynasty: Legacy is a social project. It is designed to reinforce social bonds through cooperation, trust, and long-term participation.",
    pillarTwoTitle: "Coordinated work",
    pillarTwoText: "Progress is not built by isolated activity alone. The project asks players to align, divide responsibilities, make shared decisions, and work together toward durable results.",
    pillarThreeTitle: "An open world to inhabit",
    pillarThreeText: "The world is meant to be settled by players. It grows as people arrive, build, maintain, and give each place its role within a larger living structure.",
    pillarFourTitle: "Perception and shared environment",
    pillarFourText: "We want the project to raise the quality of how people perceive common space, labor, neighborhood, and a shared future. The world should feel inhabited, legible, and socially real.",
    closingLabel: "Shared authorship",
    closingText: "Dynasty: Legacy is a world that does not simply host players. It is a world intended to be formed by them.",
    downloadCta: "Download DLSymbiosis",
    chroniclesCta: "Read Chronicles",
    madeForAlt: "Made for Dynasty Legacy",
    sloganAlt: "Gateway to the Universe",
    companyAlt: "Ozkullar Company",
    footer: "Flagship project",
  },
  ru: {
    htmlLang: "ru",
    pageTitle: "Dynasty: Legacy | DLSymbiosis",
    metaDescription: "Dynasty: Legacy — флагманский социальный градостроительный проект, вокруг которого строится мир DLSymbiosis.",
    ogDescription: "Флагманский социальный градостроительный проект, формируемый слаженной работой игроков в открытом мире.",
    homeLabel: "Главная DLSymbiosis",
    primaryNav: "Основная навигация",
    home: "Главная",
    download: "Скачать",
    updates: "Хроники",
    account: "Профиль",
    contact: "Контакты",
    flagship: "Dynasty: Legacy",
    eyebrow: "Флагманский проект",
    headline: "Dynasty: Legacy",
    lead: "Dynasty: Legacy — наш флагманский социальный градостроительный проект: открытый мир, созданный для укрепления общества через слаженную и совместную работу игроков. В его основе лежат общая ответственность, коллективное созидание и мысль о том, что мир становится по-настоящему живым тогда, когда его формируют сами люди.",
    summaryTitle: "Мир, который строят его жители",
    summaryText: "Это не декоративный фон и не пустая карта. Это живая среда, которую игроки будут заселять, развивать, организовывать и постепенно переосмыслять. Города, районы, ритм роста и сам характер мира здесь должны рождаться из действий игроков.",
    pillarOneTitle: "Социальный фундамент",
    pillarOneText: "В основе Dynasty: Legacy лежит социальная идея. Проект задуман как пространство, где укрепляются связи между людьми, привычка к сотрудничеству и чувство общей ответственности.",
    pillarTwoTitle: "Слаженная совместная работа",
    pillarTwoText: "Развитие здесь не строится на одиночных действиях. Проект требует координации, распределения ролей, совместных решений и умения работать вместе ради устойчивого результата.",
    pillarThreeTitle: "Открытый мир для заселения",
    pillarThreeText: "Этот мир должен быть заселён игроками. Он растёт по мере того, как люди приходят, строят, поддерживают порядок и придают каждому месту собственную функцию в общей системе.",
    pillarFourTitle: "Качество восприятия среды",
    pillarFourText: "Мы хотим, чтобы проект повышал качество восприятия общей среды, труда, соседства и совместного будущего. Мир должен ощущаться обжитым, понятным и социально наполненным.",
    closingLabel: "Общее авторство мира",
    closingText: "Dynasty: Legacy — это мир, который не просто принимает игроков, а формируется ими самими.",
    downloadCta: "Скачать DLSymbiosis",
    chroniclesCta: "Открыть хроники",
    madeForAlt: "Создано для Dynasty Legacy",
    sloganAlt: "Gateway to the Universe",
    companyAlt: "Ozkullar Company",
    footer: "Флагманский проект",
  },
  tr: {
    htmlLang: "tr",
    pageTitle: "Dynasty: Legacy | DLSymbiosis",
    metaDescription: "Dynasty: Legacy, DLSymbiosis evreninin arkasindaki amiral sosyal sehir kurma projesidir.",
    ogDescription: "Oyuncularin uyumlu is birligiyle sekillenen amiral sosyal sehir kurma projesi.",
    homeLabel: "DLSymbiosis ana sayfasi",
    primaryNav: "Ana gezinme",
    home: "Ana sayfa",
    download: "Indir",
    updates: "Kronikler",
    account: "Profil",
    contact: "Iletisim",
    flagship: "Dynasty: Legacy",
    eyebrow: "Amiral Proje",
    headline: "Dynasty: Legacy",
    lead: "Dynasty: Legacy, toplum yapisini oyuncularin uyumlu ve ortak emegiyle guclendirmek icin tasarlanmis amiral sosyal sehir kurma projemizdir. Temelinde ortak sorumluluk, kolektif insa ve bir dunyanin insanlar onu birlikte sekillendirdiginde gercekten anlam kazandigi fikri vardir.",
    summaryTitle: "Kendi halki tarafindan kurulan bir dunya",
    summaryText: "Bu sadece dekoratif bir arka plan degildir. Oyuncularin yerlesecegi, gelistirecegi, duzenleyecegi ve zamanla donusturecegi yasayan bir alandir. Sehirler, bolgeler, buyumenin ritmi ve cevrenin karakteri dogrudan oyuncu eylemlerinden dogmalidir.",
    pillarOneTitle: "Sosyal temel",
    pillarOneText: "Dynasty: Legacy'nin merkezinde sosyal bir fikir vardir. Proje, is birligi, guven ve uzun vadeli katilim yoluyla toplumsal baglari guclendirmek icin tasarlanmistir.",
    pillarTwoTitle: "Uyumlu ortak calisma",
    pillarTwoText: "Ilerleme tek basina yapilan hareketlerle kurulmaz. Proje, oyunculardan uyum saglamalarini, sorumluluk paylasmalarini, ortak kararlar almalarini ve kalici sonuclar icin birlikte calismalarini ister.",
    pillarThreeTitle: "Yerlesilecek acik bir dunya",
    pillarThreeText: "Bu dunya oyuncular tarafindan doldurulmak uzere tasarlanmistir. Insanlar geldikce, insa ettikce, duzeni korudukca ve her yere daha buyuk yapinin icinde bir rol verdikce dunya buyur.",
    pillarFourTitle: "Ortak cevreyi algilama kalitesi",
    pillarFourText: "Projenin ortak mekani, emegi, komsulugu ve ortak gelecegi algilama kalitesini yukseltmesini istiyoruz. Dunya yasanmis, okunabilir ve toplumsal olarak gercek hissedilmelidir.",
    closingLabel: "Ortak yazarlik",
    closingText: "Dynasty: Legacy, oyunculari sadece icinde barindiran bir dunya degildir. Onlarin elleriyle bicimlenen bir dunyadir.",
    downloadCta: "DLSymbiosis'i indir",
    chroniclesCta: "Kronikleri ac",
    madeForAlt: "Dynasty Legacy icin uretildi",
    sloganAlt: "Gateway to the Universe",
    companyAlt: "Ozkullar Company",
    footer: "Amiral proje",
  },
};

function renderDynastyLegacyPage(req) {
  const locale = getLandingLocale(req);
  const copy = FLAGSHIP_COPY[locale] || FLAGSHIP_COPY.en;
  const supportEmail = "support@dlsymbiosis.com";
  const logoUrl = getSiteAssetUrl("SymbiosisLogo.png");
  const madeForUrl = getSiteAssetUrl("MadeForDynastyLegacy.png");
  const sloganUrl = getSiteAssetUrl("Slogan.png");
  const companyUrl = getSiteAssetUrl("OzkullarCompany.png");
  const buttonUrl = SITE_BUTTON_FRAME_URL;

  return `<!doctype html>
<html lang="${escapeHtml(copy.htmlLang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b1014">
  <meta name="description" content="${escapeHtml(copy.metaDescription)}">
  <meta property="og:title" content="${escapeHtml(copy.pageTitle)}">
  <meta property="og:description" content="${escapeHtml(copy.ogDescription)}">
  <meta property="og:image" content="${escapeHtml(madeForUrl)}">
  <link rel="icon" type="image/png" href="${escapeHtml(logoUrl)}">
  <title>${escapeHtml(copy.pageTitle)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #00020b;
      --ink: #f4f8ff;
      --muted: #aab8cc;
      --line: rgba(149,194,255,.24);
      --panel: #06101d;
      --gold: #8cc8ff;
      --jade: #62d8ff;
      --button-img: url("${escapeHtml(buttonUrl)}");
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top, rgba(98,216,255,.08), transparent 38%),
        linear-gradient(180deg, #02050c 0%, #00020b 100%);
      min-height: 100vh;
    }
    a { color: inherit; }
    .shell { width: min(1100px, calc(100% - 32px)); margin: 0 auto; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(12,15,18,.88);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    .nav {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      text-decoration: none;
    }
    .brand img {
      display: block;
      width: min(190px, 42vw);
      height: auto;
    }
    .nav-right {
      display: flex;
      align-items: center;
      gap: 22px;
    }
    .navlinks {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    .navlinks a {
      min-height: 42px;
      padding: 0 18px;
      border: 1px solid rgba(140,200,255,.42);
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      white-space: nowrap;
      font-weight: 800;
      color: #eaf6ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.10), rgba(2,10,24,.42)),
        var(--button-img) center / 100% 100% no-repeat;
      box-shadow: inset 0 0 18px rgba(98,216,255,.12), 0 0 18px rgba(33,89,161,.12);
      text-shadow: 0 1px 0 #000;
    }
    .navlinks a:hover {
      color: #ffffff;
      border-color: rgba(174,220,255,.72);
      filter: brightness(1.13);
    }
    .lang-switch {
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid rgba(140,200,255,.34);
      border-radius: 10px;
      padding: 4px;
    }
    .lang-switch a {
      min-width: 34px;
      min-height: 30px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      text-decoration: none;
      font-size: 12px;
      font-weight: 800;
    }
    .lang-switch a.active {
      color: #001020;
      background: linear-gradient(180deg, #dff5ff, #62d8ff);
    }
    .hero {
      padding: 76px 0 34px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 44px;
      align-items: start;
    }
    .eyebrow {
      color: var(--gold);
      font-weight: 750;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 12px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0;
      font-size: clamp(46px, 7vw, 88px);
      line-height: .94;
      letter-spacing: 0;
    }
    .lead {
      max-width: 700px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: clamp(18px, 2vw, 22px);
      line-height: 1.56;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 32px;
    }
    .button {
      min-height: 50px;
      padding: 0 20px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      font-weight: 800;
      border: 1px solid var(--line);
    }
    .button.primary {
      color: #f4f8ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.12), rgba(2,10,24,.54)),
        var(--button-img) center / 100% 100% no-repeat;
      border-color: rgba(140,200,255,.44);
      text-shadow: 0 1px 0 #000;
      box-shadow: inset 0 0 20px rgba(98,216,255,.12), 0 0 24px rgba(33,89,161,.14);
    }
    .button.secondary {
      color: var(--ink);
      background: transparent;
    }
    .summary-card,
    .closing {
      border: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(98,216,255,.07), rgba(4,10,20,.9)),
        var(--panel);
      border-radius: 10px;
      padding: 24px;
      box-shadow: 0 14px 40px rgba(0,0,0,.24);
    }
    .summary-card img,
    .closing-art img {
      display: block;
      width: 100%;
      height: auto;
    }
    .summary-card h2,
    .closing h2 {
      margin: 18px 0 0;
      font-size: 26px;
      line-height: 1.15;
    }
    .summary-card p,
    .closing p,
    .pillar p {
      margin: 14px 0 0;
      color: var(--muted);
      line-height: 1.62;
    }
    .pillars {
      padding: 14px 0 24px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .pillar {
      min-height: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 24px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.015)),
        rgba(6,16,29,.85);
    }
    .pillar h3 {
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
    }
    .closing {
      margin: 0 0 74px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 280px;
      gap: 28px;
      align-items: center;
    }
    .closing .eyebrow {
      margin-bottom: 10px;
    }
    .closing-art {
      display: grid;
      gap: 14px;
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
    @media (max-width: 920px) {
      .hero,
      .closing {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 22px, 1100px); }
      .nav { align-items: flex-start; flex-direction: column; padding: 12px 0; }
      .nav-right { width: 100%; justify-content: space-between; gap: 12px; }
      .navlinks { flex-wrap: wrap; gap: 8px; }
      .navlinks a { min-height: 38px; padding: 0 14px; }
      .actions { display: grid; }
      .button { width: 100%; }
      .pillars { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <a class="brand" href="${escapeHtml(withLangPath("/", locale))}" aria-label="${escapeHtml(copy.homeLabel)}">
        <img src="${escapeHtml(logoUrl)}" alt="DLSymbiosis" width="1187" height="188">
      </a>
      <div class="nav-right">
        <nav class="navlinks" aria-label="${escapeHtml(copy.primaryNav)}">
          <a href="${escapeHtml(withLangPath("/", locale))}">${escapeHtml(copy.home)}</a>
          <a href="${escapeHtml(withLangPath("/download", locale))}">${escapeHtml(copy.download)}</a>
          <a href="${escapeHtml(withLangPath("/dynasty-legacy", locale))}">${escapeHtml(copy.flagship)}</a>
          <a href="${escapeHtml(withLangPath("/changelog", locale))}">${escapeHtml(copy.updates)}</a>
          <a href="${escapeHtml(withLangPath("/account", locale))}">${escapeHtml(copy.account)}</a>
          <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(copy.contact)}</a>
        </nav>
        <nav class="lang-switch" aria-label="Language">
          <a class="${locale === "en" ? "active" : ""}" href="/dynasty-legacy?lang=en" lang="en">EN</a>
          <a class="${locale === "ru" ? "active" : ""}" href="/dynasty-legacy?lang=ru" lang="ru">RU</a>
          <a class="${locale === "tr" ? "active" : ""}" href="/dynasty-legacy?lang=tr" lang="tr">TR</a>
        </nav>
      </div>
    </div>
  </header>
  <main>
    <section class="shell hero">
      <div>
        <div class="eyebrow">${escapeHtml(copy.eyebrow)}</div>
        <h1>${escapeHtml(copy.headline)}</h1>
        <p class="lead">${escapeHtml(copy.lead)}</p>
        <div class="actions">
          <a class="button primary" href="${escapeHtml(withLangPath("/download", locale))}">${escapeHtml(copy.downloadCta)}</a>
          <a class="button secondary" href="${escapeHtml(withLangPath("/changelog", locale))}">${escapeHtml(copy.chroniclesCta)}</a>
        </div>
      </div>
      <aside class="summary-card">
        <img src="${escapeHtml(madeForUrl)}" alt="${escapeHtml(copy.madeForAlt)}" width="1260" height="264">
        <h2>${escapeHtml(copy.summaryTitle)}</h2>
        <p>${escapeHtml(copy.summaryText)}</p>
      </aside>
    </section>
    <section class="shell pillars">
      <article class="pillar">
        <h3>${escapeHtml(copy.pillarOneTitle)}</h3>
        <p>${escapeHtml(copy.pillarOneText)}</p>
      </article>
      <article class="pillar">
        <h3>${escapeHtml(copy.pillarTwoTitle)}</h3>
        <p>${escapeHtml(copy.pillarTwoText)}</p>
      </article>
      <article class="pillar">
        <h3>${escapeHtml(copy.pillarThreeTitle)}</h3>
        <p>${escapeHtml(copy.pillarThreeText)}</p>
      </article>
      <article class="pillar">
        <h3>${escapeHtml(copy.pillarFourTitle)}</h3>
        <p>${escapeHtml(copy.pillarFourText)}</p>
      </article>
    </section>
    <section class="shell closing">
      <div>
        <div class="eyebrow">${escapeHtml(copy.closingLabel)}</div>
        <h2>${escapeHtml(copy.flagship)}</h2>
        <p>${escapeHtml(copy.closingText)}</p>
      </div>
      <div class="closing-art" aria-label="${escapeHtml(copy.flagship)}">
        <img src="${escapeHtml(sloganUrl)}" alt="${escapeHtml(copy.sloganAlt)}" width="951" height="303">
        <img src="${escapeHtml(companyUrl)}" alt="${escapeHtml(copy.companyAlt)}" width="1047" height="312">
      </div>
    </section>
  </main>
  <footer>
    <div class="shell">
      <span>(c) ${new Date().getFullYear()} DLSymbiosis / ${escapeHtml(copy.footer)}</span>
      <span><a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></span>
    </div>
  </footer>
</body>
</html>`;
}

const ACCOUNT_COPY = {
  en: {
    htmlLang: "en",
    pageTitle: "DLSymbiosis Profile",
    metaDescription: "Sign in to your DLSymbiosis game account or create a new profile.",
    homeLabel: "DLSymbiosis home",
    primaryNav: "Primary navigation",
    home: "Home",
    download: "Download",
    updates: "Chronicles",
    contact: "Contact",
    eyebrow: "Game Account",
    headline: "Your DLSymbiosis profile",
    lead: "Use the same account you use in the game. Sign in to see your profile, dynasty, player ID, and profile slot.",
    signIn: "Sign in",
    register: "Register",
    email: "Email",
    password: "Password",
    slot: "Profile slot",
    nickname: "Nickname",
    dynasty: "Dynasty name",
    language: "Language",
    createAccount: "Create account",
    signInButton: "Sign in",
    logout: "Log out",
    signedIn: "Signed in",
    notSignedIn: "Not signed in",
    profile: "Profile",
    account: "Account",
    playerId: "Player ID",
    dynastyId: "Dynasty ID",
    empty: "No profile loaded yet.",
    loading: "Loading...",
    savedSession: "Saved session restored.",
    loginHelp: "If you have multiple in-game profiles, choose the same slot you use in the game.",
    registerHelp: "This creates a game-compatible account and first profile slot.",
    age: "Age",
    successRegister: "Account created. You are signed in.",
    successLogin: "Signed in.",
    genericError: "Something went wrong. Please try again.",
  },
  ru: {
    htmlLang: "ru",
    pageTitle: "Профиль DLSymbiosis",
    metaDescription: "Войдите в игровой аккаунт DLSymbiosis или создайте новый профиль.",
    homeLabel: "Главная DLSymbiosis",
    primaryNav: "Основная навигация",
    home: "Главная",
    download: "Скачать",
    updates: "Хроники",
    contact: "Контакты",
    eyebrow: "Игровой аккаунт",
    headline: "Ваш профиль DLSymbiosis",
    lead: "Используйте тот же аккаунт, что и в игре. После входа здесь будет виден профиль, династия, ID игрока и слот.",
    signIn: "Войти",
    register: "Регистрация",
    email: "Email",
    password: "Пароль",
    slot: "Слот профиля",
    nickname: "Никнейм",
    dynasty: "Название династии",
    language: "Язык",
    createAccount: "Создать аккаунт",
    signInButton: "Войти",
    logout: "Выйти",
    signedIn: "Вы вошли",
    notSignedIn: "Вы не вошли",
    profile: "Профиль",
    account: "Аккаунт",
    playerId: "ID игрока",
    dynastyId: "ID династии",
    empty: "Профиль пока не загружен.",
    loading: "Загрузка...",
    savedSession: "Сохранённая сессия восстановлена.",
    loginHelp: "Если в игре несколько профилей, выберите тот же слот, которым пользуетесь в игре.",
    registerHelp: "Создаёт аккаунт, совместимый с игрой, и первый слот профиля.",
    age: "Возраст",
    successRegister: "Аккаунт создан. Вы вошли.",
    successLogin: "Вход выполнен.",
    genericError: "Что-то пошло не так. Попробуйте ещё раз.",
  },
  tr: {
    htmlLang: "tr",
    pageTitle: "DLSymbiosis Profili",
    metaDescription: "DLSymbiosis oyun hesabınıza giriş yapın veya yeni profil oluşturun.",
    homeLabel: "DLSymbiosis ana sayfası",
    primaryNav: "Ana gezinme",
    home: "Ana sayfa",
    download: "İndir",
    updates: "Kronikler",
    contact: "İletişim",
    eyebrow: "Oyun Hesabı",
    headline: "DLSymbiosis profiliniz",
    lead: "Oyunda kullandığınız aynı hesabı kullanın. Giriş yaptıktan sonra profiliniz, hanedanınız, oyuncu ID'niz ve profil slotunuz burada görünür.",
    signIn: "Giriş yap",
    register: "Kayıt ol",
    email: "Email",
    password: "Şifre",
    slot: "Profil slotu",
    nickname: "Takma ad",
    dynasty: "Hanedan adı",
    language: "Dil",
    createAccount: "Hesap oluştur",
    signInButton: "Giriş yap",
    logout: "Çıkış yap",
    signedIn: "Giriş yapıldı",
    notSignedIn: "Giriş yapılmadı",
    profile: "Profil",
    account: "Hesap",
    playerId: "Oyuncu ID",
    dynastyId: "Hanedan ID",
    empty: "Henüz profil yüklenmedi.",
    loading: "Yükleniyor...",
    savedSession: "Kayıtlı oturum geri yüklendi.",
    loginHelp: "Oyunda birden fazla profiliniz varsa oyunda kullandığınız aynı slotu seçin.",
    registerHelp: "Oyunla uyumlu bir hesap ve ilk profil slotunu oluşturur.",
    age: "Yaş",
    successRegister: "Hesap oluşturuldu. Giriş yaptınız.",
    successLogin: "Giriş yapıldı.",
    genericError: "Bir şey ters gitti. Lütfen tekrar deneyin.",
  },
};

function renderAccountPage(req) {
  const locale = getLandingLocale(req);
  const copy = ACCOUNT_COPY[locale] || ACCOUNT_COPY.en;
  const logoUrl = getSiteAssetUrl("SymbiosisLogo.png");
  const sloganUrl = getSiteAssetUrl("Slogan.png");
  const buttonUrl = SITE_BUTTON_FRAME_URL;
  const copyJson = JSON.stringify(copy).replace(/</g, "\\u003c");
  const localeJson = JSON.stringify(locale).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="${escapeHtml(copy.htmlLang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b1014">
  <meta name="description" content="${escapeHtml(copy.metaDescription)}">
  <meta property="og:image" content="${escapeHtml(logoUrl)}">
  <link rel="icon" type="image/png" href="${escapeHtml(logoUrl)}">
  <title>${escapeHtml(copy.pageTitle)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #00020b;
      --ink: #f4f8ff;
      --muted: #aab8cc;
      --line: rgba(149,194,255,.24);
      --panel: #06101d;
      --gold: #8cc8ff;
      --jade: #62d8ff;
      --danger: #e37b70;
      --button-img: url("${escapeHtml(buttonUrl)}");
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      min-height: 100vh;
    }
    a { color: inherit; }
    .shell { width: min(1040px, calc(100% - 32px)); margin: 0 auto; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: rgba(12,15,18,.88);
      border-bottom: 1px solid var(--line);
    }
    .nav {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      text-decoration: none;
    }
    .brand img {
      display: block;
      width: min(190px, 42vw);
      height: auto;
    }
    .nav-right {
      display: flex;
      align-items: center;
      gap: 22px;
    }
    .navlinks {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }
    .navlinks a {
      min-height: 42px;
      padding: 0 18px;
      border: 1px solid rgba(140,200,255,.42);
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      white-space: nowrap;
      font-weight: 800;
      color: #eaf6ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.10), rgba(2,10,24,.42)),
        var(--button-img) center / 100% 100% no-repeat;
      box-shadow: inset 0 0 18px rgba(98,216,255,.12), 0 0 18px rgba(33,89,161,.12);
      text-shadow: 0 1px 0 #000;
    }
    .navlinks a:hover {
      color: #ffffff;
      border-color: rgba(174,220,255,.72);
      filter: brightness(1.13);
    }
    .lang-switch {
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1px solid rgba(140,200,255,.34);
      border-radius: 10px;
      padding: 4px;
    }
    .lang-switch a {
      min-width: 34px;
      min-height: 30px;
      border-radius: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      text-decoration: none;
      font-size: 12px;
      font-weight: 800;
    }
    .lang-switch a.active {
      color: #001020;
      background: linear-gradient(180deg, #dff5ff, #62d8ff);
    }
    .hero {
      padding: 72px 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 390px;
      gap: 48px;
      align-items: start;
    }
    .eyebrow {
      color: var(--gold);
      font-weight: 750;
      letter-spacing: .08em;
      text-transform: uppercase;
      font-size: 12px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0;
      max-width: 680px;
      font-size: clamp(42px, 7vw, 78px);
      line-height: .95;
      letter-spacing: 0;
    }
    .lead {
      max-width: 620px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: clamp(18px, 2vw, 21px);
      line-height: 1.5;
    }
    .slogan {
      display: block;
      width: min(520px, 100%);
      height: auto;
      margin-top: 34px;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 24px;
    }
    .tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 18px;
    }
    .tab {
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,.035);
      color: var(--ink);
      font-weight: 800;
      cursor: pointer;
    }
    .tab.active {
      color: #001020;
      background: linear-gradient(180deg, #dff5ff, #62d8ff);
      border-color: transparent;
    }
    form { display: grid; gap: 12px; }
    label {
      display: grid;
      gap: 7px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 750;
    }
    input, select {
      width: 100%;
      min-height: 46px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0d1216;
      color: var(--ink);
      padding: 0 12px;
      font: inherit;
    }
    .button {
      min-height: 50px;
      padding: 0 20px;
      border-radius: 8px;
      border: 1px solid var(--line);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      font-weight: 800;
      cursor: pointer;
      color: var(--ink);
      background: transparent;
    }
    .button.primary {
      color: #f4f8ff;
      background:
        linear-gradient(180deg, rgba(140,200,255,.12), rgba(2,10,24,.54)),
        var(--button-img) center / 100% 100% no-repeat;
      border-color: rgba(140,200,255,.44);
      text-shadow: 0 1px 0 #000;
      box-shadow: inset 0 0 20px rgba(98,216,255,.12), 0 0 24px rgba(33,89,161,.14);
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      margin: 4px 0 0;
    }
    .status {
      min-height: 24px;
      margin-top: 14px;
      color: var(--muted);
      line-height: 1.45;
    }
    .status.error { color: var(--danger); }
    .status.ok { color: var(--jade); }
    .profile-card {
      display: none;
      gap: 14px;
      margin-top: 18px;
      border-top: 1px solid var(--line);
      padding-top: 18px;
    }
    .profile-card.show { display: grid; }
    .profile-card h2 {
      margin: 0;
      font-size: 24px;
    }
    .detail-list {
      display: grid;
      gap: 10px;
      color: var(--muted);
      font-size: 14px;
    }
    .detail-list div {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 10px;
    }
    .detail-list strong {
      color: var(--ink);
      text-align: right;
    }
    .hidden { display: none; }
    footer {
      padding: 28px 0 42px;
      color: var(--muted);
      border-top: 1px solid var(--line);
      font-size: 14px;
    }
    @media (max-width: 880px) {
      .hero { grid-template-columns: 1fr; padding-top: 54px; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 22px, 1040px); }
      .nav { align-items: flex-start; flex-direction: column; padding: 12px 0; }
      .nav-right { width: 100%; justify-content: space-between; gap: 12px; }
      .navlinks { flex-wrap: wrap; gap: 8px; }
      .navlinks a { min-height: 38px; padding: 0 14px; }
      .detail-list div { display: grid; gap: 4px; }
      .detail-list strong { text-align: left; }
    }
  </style>
</head>
<body>
  <header>
    <div class="shell nav">
      <a class="brand" href="${escapeHtml(withLangPath("/", locale))}" aria-label="${escapeHtml(copy.homeLabel)}">
        <img src="${escapeHtml(logoUrl)}" alt="DLSymbiosis" width="1187" height="188">
      </a>
      <div class="nav-right">
        <nav class="navlinks" aria-label="${escapeHtml(copy.primaryNav)}">
          <a href="${escapeHtml(withLangPath("/", locale))}">${escapeHtml(copy.home)}</a>
          <a href="${escapeHtml(withLangPath("/download", locale))}">${escapeHtml(copy.download)}</a>
          <a href="${escapeHtml(withLangPath("/dynasty-legacy", locale))}">Dynasty: Legacy</a>
          <a href="${escapeHtml(withLangPath("/changelog", locale))}">${escapeHtml(copy.updates)}</a>
          <a href="mailto:support@dlsymbiosis.com">${escapeHtml(copy.contact)}</a>
        </nav>
        <nav class="lang-switch" aria-label="Language">
          <a class="${locale === "en" ? "active" : ""}" href="/account?lang=en" lang="en">EN</a>
          <a class="${locale === "ru" ? "active" : ""}" href="/account?lang=ru" lang="ru">RU</a>
          <a class="${locale === "tr" ? "active" : ""}" href="/account?lang=tr" lang="tr">TR</a>
        </nav>
      </div>
    </div>
  </header>
  <main class="shell hero">
    <section>
      <div class="eyebrow">${escapeHtml(copy.eyebrow)}</div>
      <h1>${escapeHtml(copy.headline)}</h1>
      <p class="lead">${escapeHtml(copy.lead)}</p>
      <img class="slogan" src="${escapeHtml(sloganUrl)}" alt="Gateway to the Universe" width="951" height="303">
    </section>
    <section class="panel" aria-label="${escapeHtml(copy.profile)}">
      <div class="tabs">
        <button class="tab active" type="button" data-tab="login">${escapeHtml(copy.signIn)}</button>
        <button class="tab" type="button" data-tab="register">${escapeHtml(copy.register)}</button>
      </div>
      <form id="loginForm">
        <label>${escapeHtml(copy.email)}
          <input name="email" type="email" autocomplete="email" required>
        </label>
        <label>${escapeHtml(copy.password)}
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <label>${escapeHtml(copy.slot)}
          <select name="slotIndex">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <p class="hint">${escapeHtml(copy.loginHelp)}</p>
        <button class="button primary" type="submit">${escapeHtml(copy.signInButton)}</button>
      </form>
      <form id="registerForm" class="hidden">
        <label>${escapeHtml(copy.email)}
          <input name="email" type="email" autocomplete="email" required>
        </label>
        <label>${escapeHtml(copy.password)}
          <input name="password" type="password" autocomplete="new-password" minlength="6" required>
        </label>
        <label>${escapeHtml(copy.nickname)}
          <input name="nickname" type="text" maxlength="100" required>
        </label>
        <label>${escapeHtml(copy.dynasty)}
          <input name="dynastyName" type="text" maxlength="64" required>
        </label>
        <label>${escapeHtml(copy.slot)}
          <select name="slotIndex">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <label>${escapeHtml(copy.age)}
          <input name="age" type="number" min="0" max="120" value="0">
        </label>
        <input name="language" type="hidden" value="${escapeHtml(locale)}">
        <p class="hint">${escapeHtml(copy.registerHelp)}</p>
        <button class="button primary" type="submit">${escapeHtml(copy.createAccount)}</button>
      </form>
      <div id="status" class="status">${escapeHtml(copy.empty)}</div>
      <div id="profileCard" class="profile-card">
        <h2 id="profileName">${escapeHtml(copy.profile)}</h2>
        <div class="detail-list">
          <div><span>${escapeHtml(copy.account)}</span><strong id="profileEmail"></strong></div>
          <div><span>${escapeHtml(copy.playerId)}</span><strong id="playerId"></strong></div>
          <div><span>${escapeHtml(copy.dynasty)}</span><strong id="dynastyName"></strong></div>
          <div><span>${escapeHtml(copy.dynastyId)}</span><strong id="dynastyId"></strong></div>
          <div><span>${escapeHtml(copy.slot)}</span><strong id="slotIndex"></strong></div>
        </div>
        <button id="logoutButton" class="button" type="button">${escapeHtml(copy.logout)}</button>
      </div>
    </section>
  </main>
  <footer>
    <div class="shell">(c) ${new Date().getFullYear()} DLSymbiosis</div>
  </footer>
  <script>
    const copy = ${copyJson};
    const locale = ${localeJson};
    const tokenKey = "dlsymbiosis_token";
    const statusEl = document.getElementById("status");
    const profileCard = document.getElementById("profileCard");
    const loginForm = document.getElementById("loginForm");
    const registerForm = document.getElementById("registerForm");

    function setStatus(message, type) {
      statusEl.textContent = message || "";
      statusEl.className = "status" + (type ? " " + type : "");
    }

    function payloadFromForm(form) {
      return Object.fromEntries(new FormData(form).entries());
    }

    async function postJson(url, payload) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || copy.genericError);
      }
      return data;
    }

    function showProfile(data, message) {
      const user = data.user || {};
      const account = data.account || {};
      document.getElementById("profileName").textContent = user.nickname || copy.profile;
      document.getElementById("profileEmail").textContent = account.email || user.email || "-";
      document.getElementById("playerId").textContent = user.publicPlayerId || "-";
      document.getElementById("dynastyName").textContent = account.dynastyName || user.dynastyName || "-";
      document.getElementById("dynastyId").textContent = account.dynastyId || user.dynastyId || "-";
      document.getElementById("slotIndex").textContent = user.slotIndex || "-";
      profileCard.classList.add("show");
      setStatus(message || copy.signedIn, "ok");
    }

    async function restoreSession() {
      const token = localStorage.getItem(tokenKey);
      if (!token) {
        return;
      }
      setStatus(copy.loading);
      try {
        const data = await postJson("/auth/me", { token });
        showProfile(data, copy.savedSession);
      } catch (error) {
        localStorage.removeItem(tokenKey);
        profileCard.classList.remove("show");
        setStatus(copy.notSignedIn);
      }
    }

    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.tab;
        document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
        loginForm.classList.toggle("hidden", tab !== "login");
        registerForm.classList.toggle("hidden", tab !== "register");
        setStatus(copy.empty);
      });
    });

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setStatus(copy.loading);
      try {
        const data = await postJson("/login", payloadFromForm(loginForm));
        localStorage.setItem(tokenKey, data.token);
        showProfile(data, copy.successLogin);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setStatus(copy.loading);
      try {
        const payload = payloadFromForm(registerForm);
        payload.gender = "not_specified";
        payload.avatarId = 0;
        const data = await postJson("/register", payload);
        localStorage.setItem(tokenKey, data.token);
        showProfile(data, copy.successRegister);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    document.getElementById("logoutButton").addEventListener("click", async () => {
      const token = localStorage.getItem(tokenKey);
      localStorage.removeItem(tokenKey);
      profileCard.classList.remove("show");
      setStatus(copy.notSignedIn);
      if (token) {
        try { await postJson("/auth/logout", { token }); } catch (error) {}
      }
    });

    restoreSession();
  </script>
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
  res.type("html").send(renderSymbiosisLandingPage(req));
});

app.get("/download", (req, res) => {
  res.type("html").send(renderSymbiosisLandingPage(req));
});

app.get("/dynasty-legacy", (req, res) => {
  res.type("html").send(renderDynastyLegacyPage(req));
});

app.get("/account", (req, res) => {
  res.type("html").send(renderAccountPage(req));
});

app.get("/changelog", (req, res) => {
  res.type("html").send(renderChangelogPage(req));
});

app.get("/chronicles", (req, res) => {
  res.type("html").send(renderChangelogPage(req));
});

app.get("/apk", (req, res) => {
  res.redirect(302, ANDROID_EMBEDDED_APK_URL);
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

app.get("/updates/changelog", (req, res) => {
  const entries = getChangelogEntries();
  const latest = entries[0] || {};
  res.json({
    success: true,
    latestVersion: latest.version || ANDROID_EMBEDDED_VERSION_NAME,
    latestVersionCode: latest.versionCode || ANDROID_EMBEDDED_VERSION_CODE,
    entries,
    checkedAt: new Date().toISOString(),
  });
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
