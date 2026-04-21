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

function getAndroidUpdateManifest() {
  const filePath = path.join(__dirname, "downloads", "android-update.json");
  const latestVersionCode = readIntEnv("ANDROID_LATEST_VERSION_CODE", 1);
  const minimumVersionCode = readIntEnv("ANDROID_MIN_VERSION_CODE", 1);
  const updateUrl = process.env.ANDROID_UPDATE_URL || "http://91.99.176.77:8080/downloads/symbiosis-latest.apk";
  const fallback = {
    success: true,
    platform: "android",
    latestVersion: process.env.ANDROID_LATEST_VERSION || "1.0",
    latestVersionCode,
    minimumVersionCode,
    forceUpdate: readBoolEnv("ANDROID_FORCE_UPDATE", false),
    updateUrl,
    releaseNotes: process.env.ANDROID_RELEASE_NOTES || "A new Symbiosis build is available.",
    checkedAt: new Date().toISOString(),
  };

  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const fileManifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      ...fallback,
      ...fileManifest,
      success: true,
      platform: "android",
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn("Android update manifest read failed", err.message);
    return fallback;
  }
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

async function getAccountSlots(accountId) {
  if (!accountId) {
    return [];
  }

  const result = await pool.query(
    `
    SELECT id, slot_index, nickname, public_player_id, age, gender, avatar_id,
           profile_completed, is_guest, updated_at
    FROM users
    WHERE account_id = $1 AND slot_index BETWEEN 1 AND 3
    ORDER BY slot_index ASC
    `,
    [accountId]
  );

  return result.rows.map(mapProfileSlot);
}

async function getAccountSlotOverview(accountId) {
  const occupied = await getAccountSlots(accountId);
  const slots = [mapEmptyProfileSlot(1), mapEmptyProfileSlot(2), mapEmptyProfileSlot(3)];

  for (const slot of occupied) {
    const index = getSlotIndex(slot.slotIndex) - 1;
    slots[index] = { ...slot, occupied: true };
  }

  return slots;
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
  res.send("Server is running");
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
      let slotResult = await pool.query(
        "SELECT * FROM users WHERE account_id = $1 AND slot_index = $2 AND profile_completed = TRUE",
        [account.id, requestedSlot]
      );

      if (slotResult.rows.length === 0) {
        slotResult = await pool.query(
          "SELECT * FROM users WHERE account_id = $1 AND profile_completed = TRUE ORDER BY slot_index ASC LIMIT 1",
          [account.id]
        );
      }

      const user = slotResult.rows[0];
      if (!user) {
        return res.status(404).json({ success: false, error: "No profile slots found for this account" });
      }

      const token = await createSession(user.id, req.body.deviceId);
      return res.json({
        success: true,
        token,
        user: mapUser({ ...user, account_email: account.email, dynasty_name: account.dynasty_name, dynasty_id: account.dynasty_id }),
        account: mapAccount(account),
        profiles: await getAccountSlotOverview(account.id),
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
  const { email, password } = req.body;

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
      profiles: await getAccountSlotOverview(account.id),
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
      profiles: await getAccountSlotOverview(account.id),
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
