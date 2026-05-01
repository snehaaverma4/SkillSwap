const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const db      = require('../db/connection');

// ─── REGISTER ────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { name, email, password, role, teachSkills: [skillId,...], learnSkills: [skillId,...] }
router.post('/register', async (req, res) => {
  const { name, email, password, role, teachSkills = [], learnSkills = [] } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Check duplicate email
    const [existing] = await conn.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(409).json({ error: 'Email already registered.' });
    }

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Generate initials
    const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

    // Insert user (50 pts signup bonus)
    const [result] = await conn.query(
      'INSERT INTO users (name, email, password, role, points, avatar_initials) VALUES (?,?,?,?,50,?)',
      [name, email, hash, role || 'Student', initials]
    );
    const userId = result.insertId;

    // Insert teach skills (unverified by default)
    for (const skillId of teachSkills) {
      await conn.query(
        'INSERT IGNORE INTO user_teach_skills (user_id, skill_id) VALUES (?,?)',
        [userId, skillId]
      );
    }

    // Insert learn skills (wishlist)
    for (const skillId of learnSkills) {
      await conn.query(
        'INSERT IGNORE INTO user_learn_skills (user_id, skill_id) VALUES (?,?)',
        [userId, skillId]
      );
    }

    // Record signup bonus in points history
    await conn.query(
      'INSERT INTO points_history (user_id, change, reason) VALUES (?,50,"Signup bonus")',
      [userId]
    );

    await conn.commit();

    // Issue token
    const token = jwt.sign(
      { id: userId, name, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Account created successfully!',
      token,
      user: { id: userId, name, email, role: role || 'Student', points: 50, avatar_initials: initials }
    });

  } catch (err) {
    await conn.rollback();
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error during registration.' });
  } finally {
    conn.release();
  }
});

// ─── LOGIN ───────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Update last_active
    await db.query('UPDATE users SET last_active = NOW() WHERE id = ?', [user.id]);

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        points: user.points,
        avatar_initials: user.avatar_initials
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// ─── GET CURRENT USER ────────────────────────────────────────────────────────
// GET /api/auth/me  (requires token)
const authMiddleware = require('../middleware/auth');
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, role, points, avatar_initials, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
