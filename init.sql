CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  nickname VARCHAR(100) UNIQUE NOT NULL,
  device_id VARCHAR(255) UNIQUE,
  public_player_id VARCHAR(32) UNIQUE,
  language VARCHAR(32) DEFAULT 'turkish',
  age INT DEFAULT 0,
  gender VARCHAR(32) DEFAULT 'not_specified',
  avatar_id INT DEFAULT 0,
  profile_completed BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);
