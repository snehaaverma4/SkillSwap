const express = require('express');
const router  = express.Router();
const db      = require('../db/connection');
const auth    = require('../middleware/auth');

// ─── GET MY FULL PROFILE ─────────────────────────────────────────────────────
// GET /api/users/me/profile
router.get('/me/profile', auth, async (req, res) => {
  try {
    const uid = req.user.id;

    // Basic user info
    const [users] = await db.query(
      'SELECT id, name, email, role, points, avatar_initials, last_active, created_at FROM users WHERE id = ?',
      [uid]
    );
    if (!users.length) return res.status(404).json({ error: 'User not found.' });
    const user = users[0];

    // Teach skills
    const [teachSkills] = await db.query(`
      SELECT s.id, s.name, s.category, uts.is_verified, uts.test_score, uts.test_taken_at, uts.retake_after
      FROM user_teach_skills uts
      JOIN skills s ON s.id = uts.skill_id
      WHERE uts.user_id = ?
    `, [uid]);

    // Learn skills
    const [learnSkills] = await db.query(`
      SELECT s.id, s.name, s.category
      FROM user_learn_skills uls
      JOIN skills s ON s.id = uls.skill_id
      WHERE uls.user_id = ?
    `, [uid]);

    // Points history (last 10)
    const [pointsHistory] = await db.query(
      'SELECT change, reason, created_at FROM points_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
      [uid]
    );

    // Session count
    const [sessionCount] = await db.query(
      'SELECT COUNT(*) as count FROM sessions WHERE teacher_id = ? AND status = "completed"',
      [uid]
    );

    // Average rating
    const [ratingData] = await db.query(
      'SELECT AVG(rating) as avg_rating FROM sessions WHERE teacher_id = ? AND rating IS NOT NULL',
      [uid]
    );

    res.json({
      ...user,
      teachSkills,
      learnSkills,
      pointsHistory,
      sessionsCompleted: sessionCount[0].count,
      avgRating: ratingData[0].avg_rating ? parseFloat(ratingData[0].avg_rating).toFixed(1) : null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── GET PUBLIC PROFILE ───────────────────────────────────────────────────────
// GET /api/users/:id
router.get('/:id', async (req, res) => {
  try {
    const [users] = await db.query(
      'SELECT id, name, role, points, avatar_initials, created_at FROM users WHERE id = ? AND is_active = TRUE',
      [req.params.id]
    );
    if (!users.length) return res.status(404).json({ error: 'User not found.' });

    const [teachSkills] = await db.query(`
      SELECT s.id, s.name, s.category, uts.is_verified, uts.test_score
      FROM user_teach_skills uts
      JOIN skills s ON s.id = uts.skill_id
      WHERE uts.user_id = ? AND uts.is_verified = TRUE
    `, [req.params.id]);

    const [learnSkills] = await db.query(`
      SELECT s.id, s.name, s.category
      FROM user_learn_skills uls
      JOIN skills s ON s.id = uls.skill_id
      WHERE uls.user_id = ?
    `, [req.params.id]);

    const [stats] = await db.query(`
      SELECT 
        COUNT(*) as sessions_completed,
        AVG(rating) as avg_rating
      FROM sessions 
      WHERE teacher_id = ? AND status = 'completed'
    `, [req.params.id]);

    res.json({
      ...users[0],
      teachSkills,
      learnSkills,
      sessionsCompleted: stats[0].sessions_completed,
      avgRating: stats[0].avg_rating ? parseFloat(stats[0].avg_rating).toFixed(1) : null
    });

  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── BROWSE / SEARCH TEACHERS ────────────────────────────────────────────────
// GET /api/users?skill=Java&category=programming&page=1
router.get('/', async (req, res) => {
  try {
    const { skill, category, page = 1, limit = 12 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT DISTINCT
        u.id, u.name, u.role, u.avatar_initials, u.points,
        AVG(sess.rating) as avg_rating,
        COUNT(sess.id) as sessions_completed
      FROM users u
      JOIN user_teach_skills uts ON uts.user_id = u.id AND uts.is_verified = TRUE
      JOIN skills s ON s.id = uts.skill_id
      LEFT JOIN sessions sess ON sess.teacher_id = u.id AND sess.status = 'completed'
      WHERE u.is_active = TRUE
    `;
    const params = [];

    if (skill) {
      query += ' AND s.name LIKE ?';
      params.push('%' + skill + '%');
    }
    if (category && category !== 'all') {
      query += ' AND s.category = ?';
      params.push(category);
    }

    query += ' GROUP BY u.id ORDER BY avg_rating DESC, sessions_completed DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [users] = await db.query(query, params);

    // For each user, get their teach and learn skills
    const result = await Promise.all(users.map(async (u) => {
      const [teach] = await db.query(`
        SELECT s.name FROM user_teach_skills uts
        JOIN skills s ON s.id = uts.skill_id
        WHERE uts.user_id = ? AND uts.is_verified = TRUE
      `, [u.id]);
      const [learn] = await db.query(`
        SELECT s.name FROM user_learn_skills uls
        JOIN skills s ON s.id = uls.skill_id
        WHERE uls.user_id = ?
      `, [u.id]);
      return {
        ...u,
        avg_rating: u.avg_rating ? parseFloat(u.avg_rating).toFixed(1) : null,
        teachSkills: teach.map(t => t.name),
        learnSkills: learn.map(l => l.name)
      };
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
