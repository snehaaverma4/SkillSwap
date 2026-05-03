const express = require('express');
const router  = express.Router();
const db      = require('../db/connection');
const auth    = require('../middleware/auth');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

async function callGemini(prompt) {
  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4000 }
    })
  });
  const data = await response.json();
  if (!response.ok) { console.error('Gemini error:', data); throw new Error('Gemini API failed'); }
  return data.candidates[0].content.parts[0].text.trim();
}

function parseGeminiJSON(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

// POST /api/test/generate
router.post('/generate', auth, async (req, res) => {
  const { skillId } = req.body;
  if (!skillId) return res.status(400).json({ error: 'skillId is required.' });
  try {
    const [skills] = await db.query('SELECT * FROM skills WHERE id = ?', [skillId]);
    if (!skills.length) return res.status(404).json({ error: 'Skill not found.' });
    const skill = skills[0];

    const [userSkill] = await db.query(
      'SELECT * FROM user_teach_skills WHERE user_id = ? AND skill_id = ?',
      [req.user.id, skillId]
    );
    if (!userSkill.length) return res.status(403).json({ error: 'Skill not in your teach list.' });

    if (userSkill[0].retake_after && new Date() < new Date(userSkill[0].retake_after)) {
      return res.status(429).json({ error: `Retake available after ${new Date(userSkill[0].retake_after).toLocaleString()}`, retakeAfter: userSkill[0].retake_after });
    }

    const prompt = `You are an expert technical interviewer. Generate a skill verification test for "${skill.name}".

Create exactly:
- 10 MCQ questions (4 options each labeled A B C D, one correct answer)
- 5 practical/theory questions (conceptual, can include pseudocode)

Medium-to-hard difficulty. Test real understanding.

Respond ONLY with valid JSON, no markdown:
{
  "skill": "${skill.name}",
  "mcq": [{"id": 1, "question": "...", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "correct": "A"}],
  "theory": [{"id": 11, "question": "...", "hint": "..."}]
}`;

    const text = await callGemini(prompt);
    const questions = parseGeminiJSON(text);
    if (!questions.mcq || !questions.theory) throw new Error('Invalid format from AI');
    res.json({ questions, skillName: skill.name, skillId });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Failed to generate test. Please try again.' });
  }
});

// POST /api/test/evaluate
router.post('/evaluate', auth, async (req, res) => {
  const { skillId, mcqAnswers, theoryAnswers, questions } = req.body;
  if (!skillId || !mcqAnswers || !theoryAnswers || !questions) return res.status(400).json({ error: 'Missing fields.' });
  try {
    const [skills] = await db.query('SELECT name FROM skills WHERE id = ?', [skillId]);
    if (!skills.length) return res.status(404).json({ error: 'Skill not found.' });
    const skillName = skills[0].name;

    // Score MCQs
    let mcqScore = 0;
    const mcqResults = [];
    for (const q of questions.mcq) {
      const userAnswer = (mcqAnswers[q.id.toString()] || '').charAt(0).toUpperCase();
      const correct = userAnswer === q.correct.charAt(0).toUpperCase();
      if (correct) mcqScore++;
      mcqResults.push({ id: q.id, correct, userAnswer, correctAnswer: q.correct });
    }

    // Evaluate theory via Gemini
    const theoryPrompt = `Evaluate this "${skillName}" skill test. Score each answer 0-10.

${questions.theory.map(q => `Q${q.id}: ${q.question}\nExpected: ${q.hint}\nAnswer: "${theoryAnswers[q.id.toString()] || '(no answer)'}"`).join('\n\n')}

Respond ONLY with valid JSON, no markdown:
{"results": [{"id": 11, "score": 8, "feedback": "1-2 sentence feedback"}], "totalTheoryScore": 32}`;

    const evalText = await callGemini(theoryPrompt);
    const theoryEval = parseGeminiJSON(evalText);

    // MCQ: 10 × 5 = 50 pts, Theory: 5 × 10 = 50 pts
    const mcqPoints    = mcqScore * 5;
    const theoryPoints = Math.min(theoryEval.totalTheoryScore || 0, 50);
    const totalScore   = Math.min(100, mcqPoints + theoryPoints);
    const passed       = totalScore >= 70;
    const retakeAfter  = passed ? null : new Date(Date.now() + 48 * 60 * 60 * 1000);

    await db.query(
      'UPDATE user_teach_skills SET is_verified=?, test_score=?, test_taken_at=NOW(), retake_after=? WHERE user_id=? AND skill_id=?',
      [passed, totalScore, retakeAfter, req.user.id, skillId]
    );

    const [existing] = await db.query(
      'SELECT id FROM points_history WHERE user_id=? AND reason LIKE ? LIMIT 1',
      [req.user.id, `%${skillName}%`]
    );
    if (!existing.length) {
      const pts = passed ? 20 : 10;
      await db.query('UPDATE users SET points=points+? WHERE id=?', [pts, req.user.id]);
      await db.query('INSERT INTO points_history (user_id, points_change, reason) VALUES (?,?,?)', [req.user.id, pts, `Skill test - ${skillName}`]);
    }

    res.json({ totalScore, passed, mcqScore, mcqTotal: 10, mcqPoints, theoryPoints, mcqResults, theoryResults: theoryEval.results,
      message: passed
        ? `🎉 You scored ${totalScore}/100 — verified teacher for ${skillName}!`
        : `You scored ${totalScore}/100. Need 70+ to pass. Retake after 48 hours.`,
      retakeAfter });
  } catch (err) {
    console.error('Evaluate error:', err);
    res.status(500).json({ error: 'Failed to evaluate. Please try again.' });
  }
});

module.exports = router;
