-- SkillSwap Database Schema
-- Run this file in MySQL to set up your database
-- mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS skillswap;
USE skillswap;

-- ─── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  email       VARCHAR(150) NOT NULL UNIQUE,
  password    VARCHAR(255) NOT NULL,          -- bcrypt hash
  role        VARCHAR(50)  DEFAULT 'Student', -- Student, Professional, etc.
  points      INT          DEFAULT 50,        -- signup bonus
  avatar_initials VARCHAR(3) DEFAULT '',
  is_active   BOOLEAN      DEFAULT TRUE,
  last_active DATETIME     DEFAULT CURRENT_TIMESTAMP,
  created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ─── SKILLS MASTER LIST ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  name     VARCHAR(100) NOT NULL UNIQUE,
  category VARCHAR(50)  NOT NULL  -- programming, data, design, maths, language
);

INSERT IGNORE INTO skills (name, category) VALUES
  ('Python',           'data'),
  ('Java',             'programming'),
  ('C / C++',          'programming'),
  ('JavaScript',       'programming'),
  ('SQL',              'data'),
  ('DSA',              'programming'),
  ('Machine Learning', 'data'),
  ('UI / UX Design',   'design'),
  ('React',            'programming'),
  ('Data Analysis',    'data'),
  ('Mathematics',      'maths'),
  ('English / Writing','language'),
  ('Spring Boot',      'programming'),
  ('Figma',            'design'),
  ('Statistics',       'data'),
  ('Spanish',          'language');

-- ─── USER TEACH SKILLS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_teach_skills (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  skill_id     INT NOT NULL,
  is_verified  BOOLEAN DEFAULT FALSE,        -- becomes true after passing test
  test_score   INT     DEFAULT NULL,         -- 0-100
  test_taken_at DATETIME DEFAULT NULL,
  retake_after DATETIME DEFAULT NULL,        -- 48hr cooldown
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id),
  UNIQUE KEY uq_user_skill (user_id, skill_id)
);

-- ─── USER LEARN SKILLS (wishlist) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_learn_skills (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  skill_id   INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES skills(id),
  UNIQUE KEY uq_user_learn (user_id, skill_id)
);

-- ─── MATCHES ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_a       INT NOT NULL,
  user_b       INT NOT NULL,
  match_score  INT DEFAULT 0,               -- percentage overlap
  status       ENUM('pending','accepted','rejected','completed') DEFAULT 'pending',
  swap_type    ENUM('direct','points') DEFAULT 'direct',
  requested_by INT NOT NULL,               -- who sent the request
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_a) REFERENCES users(id),
  FOREIGN KEY (user_b) REFERENCES users(id),
  FOREIGN KEY (requested_by) REFERENCES users(id)
);

-- ─── SESSIONS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  teacher_id   INT NOT NULL,
  learner_id   INT NOT NULL,
  skill_id     INT NOT NULL,
  match_id     INT DEFAULT NULL,
  status       ENUM('scheduled','completed','cancelled') DEFAULT 'scheduled',
  scheduled_at DATETIME DEFAULT NULL,
  completed_at DATETIME DEFAULT NULL,
  rating       INT DEFAULT NULL,             -- 1-5 from learner
  review       TEXT DEFAULT NULL,
  points_awarded INT DEFAULT 0,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (teacher_id) REFERENCES users(id),
  FOREIGN KEY (learner_id) REFERENCES users(id),
  FOREIGN KEY (skill_id)   REFERENCES skills(id)
);

-- ─── POINTS HISTORY ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS points_history (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  change      INT NOT NULL,                 -- positive = earned, negative = spent
  reason      VARCHAR(200) NOT NULL,
  ref_id      INT DEFAULT NULL,             -- session_id or match_id
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─── SEED DEMO USERS (password = "password123" for all) ───────────────────────
-- bcrypt hash of "password123" with salt 10:
INSERT IGNORE INTO users (name, email, password, role, points, avatar_initials) VALUES
('Rohan Kumar',  'rohan@demo.com',  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Student',     120, 'RK'),
('Priya Sharma', 'priya@demo.com',  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Professional', 210, 'PS'),
('Arjun Mehta',  'arjun@demo.com',  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Student',      90, 'AM'),
('Divya Nair',   'divya@demo.com',  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Freelancer',  310, 'DN'),
('Karan Joshi',  'karan@demo.com',  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Student',     170, 'KJ');

-- Seed teach skills for demo users
-- Rohan teaches Java(2), DSA(6), C++(3)
INSERT IGNORE INTO user_teach_skills (user_id, skill_id, is_verified, test_score) VALUES
(1,2,TRUE,88),(1,6,TRUE,92),(1,3,TRUE,78),
(2,5,TRUE,95),(2,10,TRUE,90),
(3,9,TRUE,85),(3,4,TRUE,80),
(4,8,TRUE,97),(4,14,TRUE,91),
(5,7,TRUE,89),(5,1,TRUE,94);

-- Seed learn skills for demo users
INSERT IGNORE INTO user_learn_skills (user_id, skill_id) VALUES
(1,1),(1,7),   -- Rohan wants Python, ML
(2,8),(2,9),   -- Priya wants Design, React
(3,7),(3,1),   -- Arjun wants ML, Python
(4,1),(4,5),   -- Divya wants Python, SQL
(5,2),(5,6);   -- Karan wants Java, DSA
