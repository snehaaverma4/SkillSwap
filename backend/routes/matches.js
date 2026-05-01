const express = require('express');
const router  = express.Router();
const db      = require('../db/connection');
const auth    = require('../middleware/auth');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Calculate match score between two users
// Returns 0-100 based on teach/learn overlap
async function calcMatchScore(userAId, userBId) {
  // What A teaches that B wants to learn
  const [aTeachesBWants] = await db.query(`
    SELECT COUNT(*) as count FROM user_teach_skills uts
    JOIN user_learn_skills uls ON uls.skill_id = uts.skill_id
    WHERE uts.user_id = ? AND uls.user_id = ? AND uts.is_verified = TRUE
  `, [userAId, userBId]);

  // What B teaches that A wants to learn
  const [bTeachesAWants] = await db.query(`
    SELECT COUNT(*) as count FROM user_teach_skills uts
    JOIN user_learn_skills uls ON uls.skill_id = uts.skill_id
    WHERE uts.user_id = ? AND uls.user_id = ? AND uts.is_verified = TRUE
  `, [userBId, userAId]);

  // Total learn skills A has
  const [aLearnTotal] = await db.query(
    'SELECT COUNT(*) as count FROM user_learn_skills WHERE user_id = ?', [userAId]
  );

  // Total learn skills B has
  const [bLearnTotal] = await db.query(
    'SELECT COUNT(*) as count FROM user_learn_skills WHERE user_id = ?', [userBId]
  );

  const aScore = aLearnTotal[0].count > 0 ? (bTeachesAWants[0].count / aLearnTotal[0].count) : 0;
  const bScore = bLearnTotal[0].count > 0 ? (aTeachesBWants[0].count / bLearnTotal[0].count) : 0;

  return Math.round(((aScore + bScore) / 2) * 100);
}

// ─── GET MY MATCHES ───────────────────────────────────────────────────────────
// GET /api/matches
// Returns users who have overlapping teach/learn skills with me
router.get('/', auth, async (req, res) => {
  try {
    const uid = req.user.id;

    // Find users whose teach skills overlap with my learn skills
    const [potentialMatches] = await db.query(`
      SELECT DISTINCT
        u.id, u.name, u.role, u.avatar_initials, u.points
      FROM users u
      JOIN user_teach_skills uts ON uts.user_id = u.id AND uts.is_verified = TRUE
      JOIN user_learn_skills my_learn ON my_learn.skill_id = uts.skill_id AND my_learn.user_id = ?
      WHERE u.id != ? AND u.is_active = TRUE
      LIMIT 20
    `, [uid, uid]);

    // For each potential match calculate score + get their skills
    const result = await Promise.all(potentialMatches.map(async (match) => {
      const score = await calcMatchScore(uid, match.id);

      const [theyTeach] = await db.query(`
        SELECT s.name FROM user_teach_skills uts
        JOIN skills s ON s.id = uts.skill_id
        WHERE uts.user_id = ? AND uts.is_verified = TRUE
      `, [match.id]);

      const [theyLearn] = await db.query(`
        SELECT s.name FROM user_learn_skills uls
        JOIN skills s ON s.id = uls.skill_id
        WHERE uls.user_id = ?
      `, [match.id]);

      // Check if match request already exists
      const [existing] = await db.query(`
        SELECT id, status FROM matches
        WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)
        LIMIT 1
      `, [uid, match.id, match.id, uid]);

      return {
        ...match,
        matchScore: score,
        teachSkills: theyTeach.map(t => t.name),
        learnSkills: theyLearn.map(l => l.name),
        existingMatch: existing[0] || null
      };
    }));

    // Sort by match score desc
    result.sort((a, b) => b.matchScore - a.matchScore);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── PROPOSE A SWAP ───────────────────────────────────────────────────────────
// POST /api/matches
// Body: { targetUserId, swapType: "direct" | "points" }
router.post('/', auth, async (req, res) => {
  const { targetUserId, swapType = 'direct' } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required.' });

  const uid = req.user.id;

  try {
    // Can't match with yourself
    if (parseInt(targetUserId) === uid) {
      return res.status(400).json({ error: 'Cannot match with yourself.' });
    }

    // Check if target user exists
    const [target] = await db.query('SELECT id FROM users WHERE id = ?', [targetUserId]);
    if (!target.length) return res.status(404).json({ error: 'User not found.' });

    // Check if match already exists
    const [existing] = await db.query(`
      SELECT id, status FROM matches
      WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)
    `, [uid, targetUserId, targetUserId, uid]);

    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Match request already exists.',
        match: existing[0]
      });
    }

    const score = await calcMatchScore(uid, targetUserId);

    const [result] = await db.query(
      'INSERT INTO matches (user_a, user_b, match_score, swap_type, requested_by) VALUES (?,?,?,?,?)',
      [uid, targetUserId, score, swapType, uid]
    );

    res.status(201).json({
      message: 'Swap request sent!',
      matchId: result.insertId,
      matchScore: score
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── ACCEPT / REJECT MATCH ───────────────────────────────────────────────────
// PATCH /api/matches/:id
// Body: { action: "accept" | "reject" }
router.patch('/:id', auth, async (req, res) => {
  const { action } = req.body;
  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Action must be "accept" or "reject".' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM matches WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Match not found.' });

    const match = rows[0];

    // Only the non-requester can accept/reject
    if (match.requested_by === req.user.id) {
      return res.status(403).json({ error: 'You cannot accept your own request.' });
    }

    // Must be one of the two users
    if (match.user_a !== req.user.id && match.user_b !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const status = action === 'accept' ? 'accepted' : 'rejected';
    await db.query('UPDATE matches SET status = ? WHERE id = ?', [status, req.params.id]);

    res.json({ message: `Match ${status}.`, matchId: match.id });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── GET INCOMING REQUESTS ────────────────────────────────────────────────────
// GET /api/matches/incoming
router.get('/incoming', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT m.*, u.name as requester_name, u.avatar_initials, u.role
      FROM matches m
      JOIN users u ON u.id = m.requested_by
      WHERE (m.user_a = ? OR m.user_b = ?)
        AND m.requested_by != ?
        AND m.status = 'pending'
      ORDER BY m.created_at DESC
    `, [req.user.id, req.user.id, req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
