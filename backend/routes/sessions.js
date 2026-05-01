const express = require('express');
const router  = express.Router();
const db      = require('../db/connection');
const auth    = require('../middleware/auth');

// ─── GET MY SESSIONS ──────────────────────────────────────────────────────────
// GET /api/sessions  (as teacher or learner)
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        s.*,
        t.name as teacher_name, t.avatar_initials as teacher_initials,
        l.name as learner_name, l.avatar_initials as learner_initials,
        sk.name as skill_name
      FROM sessions s
      JOIN users t  ON t.id  = s.teacher_id
      JOIN users l  ON l.id  = s.learner_id
      JOIN skills sk ON sk.id = s.skill_id
      WHERE s.teacher_id = ? OR s.learner_id = ?
      ORDER BY s.created_at DESC
    `, [req.user.id, req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── BOOK A SESSION ───────────────────────────────────────────────────────────
// POST /api/sessions
// Body: { teacherId, skillId, scheduledAt, matchId? }
router.post('/', auth, async (req, res) => {
  const { teacherId, skillId, scheduledAt, matchId } = req.body;

  if (!teacherId || !skillId) {
    return res.status(400).json({ error: 'teacherId and skillId are required.' });
  }

  const learnerId = req.user.id;

  if (parseInt(teacherId) === learnerId) {
    return res.status(400).json({ error: 'You cannot book a session with yourself.' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Verify teacher has the skill verified
    const [teacherSkill] = await conn.query(
      'SELECT id FROM user_teach_skills WHERE user_id = ? AND skill_id = ? AND is_verified = TRUE',
      [teacherId, skillId]
    );
    if (!teacherSkill.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'Teacher is not verified for this skill.' });
    }

    // Check if learner is using points (no direct match) — deduct 20 pts
    let pointsSpent = 0;
    if (!matchId) {
      const [learner] = await conn.query('SELECT points FROM users WHERE id = ?', [learnerId]);
      if (learner[0].points < 20) {
        await conn.rollback();
        return res.status(400).json({ error: 'Insufficient points. You need at least 20 pts to book a session.' });
      }
      await conn.query('UPDATE users SET points = points - 20 WHERE id = ?', [learnerId]);
      await conn.query(
        'INSERT INTO points_history (user_id, change, reason, ref_id) VALUES (?, -20, "Session booking", ?)',
        [learnerId, skillId]
      );
      pointsSpent = 20;
    }

    const [result] = await conn.query(
      'INSERT INTO sessions (teacher_id, learner_id, skill_id, match_id, scheduled_at) VALUES (?,?,?,?,?)',
      [teacherId, learnerId, skillId, matchId || null, scheduledAt || null]
    );

    await conn.commit();

    res.status(201).json({
      message: 'Session booked successfully!',
      sessionId: result.insertId,
      pointsSpent
    });

  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    conn.release();
  }
});

// ─── COMPLETE SESSION + RATE ──────────────────────────────────────────────────
// PATCH /api/sessions/:id/complete
// Body: { rating: 1-5, review?: "text" }
// Only the learner can call this
router.patch('/:id/complete', auth, async (req, res) => {
  const { rating, review } = req.body;
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ error: 'Session not found.' }); }

    const session = rows[0];

    if (session.learner_id !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ error: 'Only the learner can complete and rate the session.' });
    }

    if (session.status === 'completed') {
      await conn.rollback();
      return res.status(400).json({ error: 'Session already completed.' });
    }

    // Mark session complete
    await conn.query(
      'UPDATE sessions SET status="completed", completed_at=NOW(), rating=?, review=? WHERE id=?',
      [rating, review || null, session.id]
    );

    // Award teacher points
    let pointsAwarded = 30; // base
    if (rating === 5) pointsAwarded += 50; // 5★ bonus

    await conn.query('UPDATE users SET points = points + ? WHERE id = ?', [pointsAwarded, session.teacher_id]);
    await conn.query(
      'INSERT INTO points_history (user_id, change, reason, ref_id) VALUES (?,?,?,?)',
      [session.teacher_id, pointsAwarded,
        rating === 5 ? 'Teaching session (+5★ bonus)' : 'Teaching session completed',
        session.id]
    );

    await conn.query(
      'UPDATE sessions SET points_awarded = ? WHERE id = ?',
      [pointsAwarded, session.id]
    );

    // Check if teacher avg rating dropped below 3.5 → flag for re-verification
    const [ratingData] = await conn.query(
      'SELECT AVG(rating) as avg FROM sessions WHERE teacher_id = ? AND status="completed" AND rating IS NOT NULL',
      [session.teacher_id]
    );
    const avg = parseFloat(ratingData[0].avg);
    if (avg < 3.5) {
      // Mark all their skills as needing re-verification
      await conn.query(
        'UPDATE user_teach_skills SET is_verified = FALSE WHERE user_id = ?',
        [session.teacher_id]
      );
    }

    await conn.commit();

    res.json({
      message: 'Session completed! Teacher has been awarded points.',
      pointsAwarded,
      teacherRatingAvg: avg.toFixed(1)
    });

  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    conn.release();
  }
});

// ─── CANCEL SESSION ───────────────────────────────────────────────────────────
router.patch('/:id/cancel', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM sessions WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Session not found.' });

    const s = rows[0];
    if (s.teacher_id !== req.user.id && s.learner_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    await db.query('UPDATE sessions SET status = "cancelled" WHERE id = ?', [req.params.id]);
    res.json({ message: 'Session cancelled.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
