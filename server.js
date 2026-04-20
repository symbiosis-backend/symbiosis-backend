console.log("AUTO DEPLOY WORKS");
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use((req, res, next) => {
  console.log(req.method, req.url);
  next();
});

app.use(cors());
app.use(express.json());

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

function mapUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    publicPlayerId: row.public_player_id,
    deviceId: row.device_id,
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

async function getUserByToken(token) {
  if (!token) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT u.*
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
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
    SELECT u.*
    FROM user_devices d
    JOIN users u ON u.id = d.user_id
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

async function ensureSchema() {
  await pool.query(`
    ALTER TABLE users
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
}

ensureSchema()
  .then(() => console.log("Profile schema ready"))
  .catch((err) => console.error("Profile schema failed", err));

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/register", async (req, res) => {
  const { email, password, nickname, deviceId, language, age, gender, avatarId } = req.body;

  if (!email || !password || !nickname) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  try {
    const passwordHash = hashPassword(password);
    const result = await pool.query(
      `
      INSERT INTO users (
        email, password, password_hash, nickname, device_id, public_player_id, language,
        age, gender, avatar_id, profile_completed, is_guest, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, FALSE, NOW())
      RETURNING *
      `,
      [
        email,
        password,
        passwordHash,
        nickname,
        deviceId || null,
        generatePublicPlayerId(),
        normalizeLanguage(language),
        Math.max(0, Number(age) || 0),
        normalizeGender(gender),
        Math.max(0, Number(avatarId) || 0),
      ]
    );

    const token = await createSession(result.rows[0].id, deviceId);
    res.json({ success: true, token, user: mapUser(result.rows[0]) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
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

    const seed = safeDeviceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || Date.now().toString();
    const email = `${seed.toLowerCase()}@device.symbiosis.local`;
    const nickname = `Player_${seed.slice(0, 8)}`;
    const password = `device:${safeDeviceId}`;

    const result = await pool.query(
      `
      INSERT INTO users (
        email, password, password_hash, nickname, device_id, public_player_id, language,
        profile_completed, is_guest, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, TRUE, NOW())
      RETURNING *
      `,
      [email, password, hashPassword(password), nickname, safeDeviceId, generatePublicPlayerId(), normalizeLanguage(language)]
    );

    const newToken = await createSession(result.rows[0].id, safeDeviceId);
    res.json({ success: true, token: newToken, user: mapUser(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/profiles/complete", async (req, res) => {
  const { deviceId, token, email, password, nickname, age, gender, avatarId, language } = req.body;

  if ((!deviceId && !token) || !nickname) {
    return res.status(400).json({ success: false, error: "Missing account or nickname" });
  }

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  if (String(password).length < 6) {
    return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
  }

  try {
    const sessionUser = await getUserByToken(token);
    const deviceUser = await getUserByDevice(deviceId);
    const user = sessionUser || deviceUser;

    if (!user) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }

    const emailOwner = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND id <> $2",
      [String(email).trim().toLowerCase(), user.id]
    );

    if (emailOwner.rows.length > 0) {
      return res.status(409).json({ success: false, error: "Email is already registered" });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET email = $2,
          password = $3,
          password_hash = $4,
          nickname = $5,
          age = $6,
          gender = $7,
          avatar_id = $8,
          language = $9,
          profile_completed = TRUE,
          is_guest = FALSE,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        user.id,
        String(email).trim().toLowerCase(),
        String(password),
        hashPassword(password),
        String(nickname).trim(),
        Math.max(0, Number(age) || 0),
        normalizeGender(gender),
        Math.max(0, Number(avatarId) || 0),
        normalizeLanguage(language),
      ]
    );

    const nextToken = token || await createSession(user.id, deviceId);
    await attachDevice(user.id, deviceId);

    res.json({ success: true, token: nextToken, user: mapUser(result.rows[0]) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
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
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ success: false, error: "Missing requestId" });
  }

  try {
    const requestResult = await pool.query(
      "SELECT * FROM friend_requests WHERE id = $1 AND status = 'pending'",
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Request not found" });
    }

    const request = requestResult.rows[0];

    await pool.query(
      "UPDATE friend_requests SET status = 'accepted' WHERE id = $1",
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
