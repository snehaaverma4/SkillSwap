const express = require('express');
const router  = express.Router();
const db      = require('../db/connection');
const auth    = require('../middleware/auth');

// ─── GET ALL SKILLS ───────────────────────────────────────────────────────────
// GET /api/skills
router.get('/', async (req, res) => {
  try {
    const [skills] = await db.query('SELECT * FROM skills ORDER BY category, name');
    res.json(skills);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── ADD TEACH SKILL ─────────────────────────────────────────────────────────
// POST /api/skills/teach
// Body: { skillId }
router.post('/teach', auth, async (req, res) => {
  const { skillId } = req.body;
  if (!skillId) return res.status(400).json({ error: 'skillId is required.' });

  try {
    await db.query(
      'INSERT IGNORE INTO user_teach_skills (user_id, skill_id) VALUES (?,?)',
      [req.user.id, skillId]
    );
    res.json({ message: 'Skill added. Complete the verification test to get your badge.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── ADD LEARN SKILL ─────────────────────────────────────────────────────────
// POST /api/skills/learn
// Body: { skillId }
router.post('/learn', auth, async (req, res) => {
  const { skillId } = req.body;
  if (!skillId) return res.status(400).json({ error: 'skillId is required.' });

  try {
    await db.query(
      'INSERT IGNORE INTO user_learn_skills (user_id, skill_id) VALUES (?,?)',
      [req.user.id, skillId]
    );
    res.json({ message: 'Skill added to your learning wishlist.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── REMOVE TEACH SKILL ──────────────────────────────────────────────────────
router.delete('/teach/:skillId', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_teach_skills WHERE user_id = ? AND skill_id = ?',
      [req.user.id, req.params.skillId]
    );
    res.json({ message: 'Skill removed.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── REMOVE LEARN SKILL ──────────────────────────────────────────────────────
router.delete('/learn/:skillId', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_learn_skills WHERE user_id = ? AND skill_id = ?',
      [req.user.id, req.params.skillId]
    );
    res.json({ message: 'Skill removed from wishlist.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── TAKE SKILL TEST (simulated) ─────────────────────────────────────────────
// POST /api/skills/test
// Body: { skillId, answers: { q1: "A", q2: "C", ... } }
//
// In production this would use Claude API to evaluate answers.
// For now we simulate: random score 60-100 to show the flow.
router.post('/test', auth, async (req, res) => {
  const { skillId } = req.body;
  if (!skillId) return res.status(400).json({ error: 'skillId is required.' });

  try {
    // Check the skill belongs to user
    const [rows] = await db.query(
      'SELECT * FROM user_teach_skills WHERE user_id = ? AND skill_id = ?',
      [req.user.id, skillId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Skill not found in your teach list.' });
    }

    const entry = rows[0];

    // Check retake cooldown
    if (entry.retake_after && new Date() < new Date(entry.retake_after)) {
      return res.status(429).json({
        error: 'You must wait before retaking this test.',
        retakeAfter: entry.retake_after
      });
    }

    // Simulate score (replace with Claude API in production)
    const score = Math.floor(Math.random() * 40) + 60; // 60–100
    const passed = score >= 70;
    const retakeAfter = passed ? null : new Date(Date.now() + 48 * 60 * 60 * 1000);

    await db.query(
      `UPDATE user_teach_skills 
       SET is_verified = ?, test_score = ?, test_taken_at = NOW(), retake_after = ?
       WHERE user_id = ? AND skill_id = ?`,
      [passed, score, retakeAfter, req.user.id, skillId]
    );

    // Award +10 pts for attempting test
    if (!entry.test_taken_at) {
      await db.query('UPDATE users SET points = points + 10 WHERE id = ?', [req.user.id]);
      await db.query(
        'INSERT INTO points_history (user_id, change, reason) VALUES (?,10,"First skill test attempt")',
        [req.user.id]
      );
    }

    res.json({
      score,
      passed,
      message: passed
        ? `Congratulations! You scored ${score}/100 and are now a verified teacher.`
        : `You scored ${score}/100. A score of 70+ is needed. You can retake after 48 hours.`,
      retakeAfter
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
