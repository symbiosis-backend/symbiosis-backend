console.log("AUTO DEPLOY WORKS");
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
  `);

  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_device_id_unique ON users(device_id) WHERE device_id IS NOT NULL");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_public_player_id_unique ON users(public_player_id) WHERE public_player_id IS NOT NULL");
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
    const result = await pool.query(
      `
      INSERT INTO users (
        email, password, nickname, device_id, public_player_id, language,
        age, gender, avatar_id, profile_completed, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW())
      RETURNING *
      `,
      [
        email,
        password,
        nickname,
        deviceId || null,
        generatePublicPlayerId(),
        normalizeLanguage(language),
        Math.max(0, Number(age) || 0),
        normalizeGender(gender),
        Math.max(0, Number(avatarId) || 0),
      ]
    );

    res.json({ success: true, user: mapUser(result.rows[0]) });
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
      "SELECT id, email, nickname, created_at FROM users WHERE email = $1 AND password = $2",
      [email, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
  const { deviceId, language } = req.body;

  if (!deviceId) {
    return res.status(400).json({ success: false, error: "Missing deviceId" });
  }

  const safeDeviceId = String(deviceId).trim();
  if (!safeDeviceId) {
    return res.status(400).json({ success: false, error: "Invalid deviceId" });
  }

  try {
    const existing = await pool.query("SELECT * FROM users WHERE device_id = $1", [safeDeviceId]);
    if (existing.rows.length > 0) {
      const updated = await pool.query(
        "UPDATE users SET language = COALESCE($2, language), updated_at = NOW() WHERE device_id = $1 RETURNING *",
        [safeDeviceId, normalizeLanguage(language)]
      );
      return res.json({ success: true, user: mapUser(updated.rows[0]) });
    }

    const seed = safeDeviceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || Date.now().toString();
    const email = `${seed.toLowerCase()}@device.symbiosis.local`;
    const nickname = `Player_${seed.slice(0, 8)}`;
    const password = `device:${safeDeviceId}`;

    const result = await pool.query(
      `
      INSERT INTO users (
        email, password, nickname, device_id, public_player_id, language,
        profile_completed, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW())
      RETURNING *
      `,
      [email, password, nickname, safeDeviceId, generatePublicPlayerId(), normalizeLanguage(language)]
    );

    res.json({ success: true, user: mapUser(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/profiles/complete", async (req, res) => {
  const { deviceId, nickname, age, gender, avatarId, language } = req.body;

  if (!deviceId || !nickname) {
    return res.status(400).json({ success: false, error: "Missing deviceId or nickname" });
  }

  try {
    const result = await pool.query(
      `
      UPDATE users
      SET nickname = $2,
          age = $3,
          gender = $4,
          avatar_id = $5,
          language = $6,
          profile_completed = TRUE,
          updated_at = NOW()
      WHERE device_id = $1
      RETURNING *
      `,
      [
        String(deviceId).trim(),
        String(nickname).trim(),
        Math.max(0, Number(age) || 0),
        normalizeGender(gender),
        Math.max(0, Number(avatarId) || 0),
        normalizeLanguage(language),
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }

    res.json({ success: true, user: mapUser(result.rows[0]) });
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
