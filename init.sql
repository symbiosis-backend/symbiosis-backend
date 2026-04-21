CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  dynasty_name VARCHAR(64) NOT NULL,
  dynasty_id VARCHAR(32) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  slot_index INT DEFAULT 1,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  password_hash TEXT,
  nickname VARCHAR(100) NOT NULL,
  device_id VARCHAR(255) UNIQUE,
  public_player_id VARCHAR(32) UNIQUE,
  language VARCHAR(32) DEFAULT 'turkish',
  age INT DEFAULT 0,
  gender VARCHAR(32) DEFAULT 'not_specified',
  avatar_id INT DEFAULT 0,
  profile_completed BOOLEAN DEFAULT FALSE,
  is_guest BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_devices (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(128) UNIQUE NOT NULL,
  device_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_chat_messages (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel VARCHAR(32) NOT NULL DEFAULT 'global',
  text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS global_chat_messages_created_id_idx
ON global_chat_messages(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS global_chat_messages_channel_id_idx
ON global_chat_messages(channel, id DESC);

CREATE TABLE IF NOT EXISTS friend_requests (
  id SERIAL PRIMARY KEY,
  sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_unique_pending
ON friend_requests(sender_id, receiver_id)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS friend_requests_receiver_status_idx
ON friend_requests(receiver_id, status);

CREATE TABLE IF NOT EXISTS friends (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY(user_id, friend_id)
);

CREATE INDEX IF NOT EXISTS friends_user_id_idx
ON friends(user_id);

CREATE INDEX IF NOT EXISTS users_nickname_idx
ON users(nickname);
