const express = require('express');
const router  = express.Router();
const db      = require('../db/connection');
const auth    = require('../middleware/auth');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── GENERATE QUESTIONS ───────────────────────────────────────────────────────
// POST /api/test/generate
// Body: { skillId }
router.post('/generate', auth, async (req, res) => {
  const { skillId } = req.body;
  if (!skillId) return res.status(400).json({ error: 'skillId is required.' });

  try {
    // Get skill name
    const [skills] = await db.query('SELECT * FROM skills WHERE id = ?', [skillId]);
    if (!skills.length) return res.status(404).json({ error: 'Skill not found.' });
    const skill = skills[0];

    // Check user has this skill in teach list
    const [userSkill] = await db.query(
      'SELECT * FROM user_teach_skills WHERE user_id = ? AND skill_id = ?',
      [req.user.id, skillId]
    );
    if (!userSkill.length) {
      return res.status(403).json({ error: 'This skill is not in your teach list.' });
    }

    // Check retake cooldown
    if (userSkill[0].retake_after && new Date() < new Date(userSkill[0].retake_after)) {
      const retakeDate = new Date(userSkill[0].retake_after).toLocaleString();
      return res.status(429).json({
        error: `You can retake this test after ${retakeDate}`,
        retakeAfter: userSkill[0].retake_after
      });
    }

    // Call Claude API to generate questions
    const prompt = `You are an expert technical interviewer. Generate a skill verification test for "${skill.name}".

Create exactly:
- 10 MCQ questions (multiple choice, 4 options each, one correct answer)
- 4 practical/theory questions (short answer, no coding required — conceptual understanding)

The questions should test REAL understanding, not just definitions. Medium difficulty.

Respond ONLY with valid JSON in this exact format, nothing else:
{
  "skill": "${skill.name}",
  "mcq": [
    {
      "id": 1,
      "question": "question text here",
      "options": ["A. option1", "B. option2", "C. option3", "D. option4"],
      "correct": "A"
    }
  ],
  "theory": [
    {
      "id": 11,
      "question": "question text here",
      "hint": "what a good answer should mention"
    }
  ]
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error:', data);
      return res.status(500).json({ error: 'Failed to generate questions. Try again.' });
    }

    const text = data.content[0].text.trim();
    const questions = JSON.parse(text);

    res.json({ questions, skillName: skill.name, skillId });

  } catch (err) {
    console.error('Test generate error:', err);
    res.status(500).json({ error: 'Failed to generate test. Please try again.' });
  }
});

// ─── EVALUATE ANSWERS ─────────────────────────────────────────────────────────
// POST /api/test/evaluate
// Body: { skillId, mcqAnswers: {"1": "A", "2": "C"...}, theoryAnswers: {"11": "text"...}, questions }
router.post('/evaluate', auth, async (req, res) => {
  const { skillId, mcqAnswers, theoryAnswers, questions } = req.body;
  if (!skillId || !mcqAnswers || !theoryAnswers || !questions) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const [skills] = await db.query('SELECT name FROM skills WHERE id = ?', [skillId]);
    if (!skills.length) return res.status(404).json({ error: 'Skill not found.' });
    const skillName = skills[0].name;

    // Score MCQs automatically
    let mcqScore = 0;
    const mcqResults = [];
    for (const q of questions.mcq) {
      const userAnswer = mcqAnswers[q.id.toString()] || '';
      const correct = userAnswer.charAt(0) === q.correct;
      if (correct) mcqScore++;
      mcqResults.push({
        id: q.id,
        correct,
        userAnswer,
        correctAnswer: q.correct
      });
    }

    // Evaluate theory answers via Claude
    const theoryPrompt = `You are evaluating a skill test for "${skillName}".

Here are the theory questions and the candidate's answers. Score each answer from 0-10 based on correctness and understanding.

${questions.theory.map(q => `
Question ${q.id}: ${q.question}
Hint (what good answer should mention): ${q.hint}
Candidate's answer: ${theoryAnswers[q.id.toString()] || '(no answer)'}
`).join('\n')}

Respond ONLY with valid JSON, nothing else:
{
  "results": [
    {
      "id": 11,
      "score": 8,
      "feedback": "brief feedback here"
    }
  ],
  "totalTheoryScore": 32
}`;

    const evalResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: theoryPrompt }]
      })
    });

    const evalData = await evalResponse.json();
    const evalText = evalData.content[0].text.trim();
    const theoryEval = JSON.parse(evalText);

    // Calculate final score
    // MCQ: 10 questions × 5 points = 50 points
    // Theory: 4 questions × 10 points = 40 points (already out of 40)
    // Bonus: 10 points
    const mcqPoints = mcqScore * 5;           // max 50
    const theoryPoints = theoryEval.totalTheoryScore; // max 40
    const totalScore = Math.min(100, mcqPoints + theoryPoints + 10); // +10 bonus, max 100

    const passed = totalScore >= 70;
    const retakeAfter = passed ? null : new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Update DB
    await db.query(
      `UPDATE user_teach_skills 
       SET is_verified = ?, test_score = ?, test_taken_at = NOW(), retake_after = ?
       WHERE user_id = ? AND skill_id = ?`,
      [passed, totalScore, retakeAfter, req.user.id, skillId]
    );

    // Award points
    const [existing] = await db.query(
      'SELECT id FROM points_history WHERE user_id = ? AND reason LIKE ? LIMIT 1',
      [req.user.id, `%skill test%${skillName}%`]
    );

    if (!existing.length) {
      const pts = passed ? 20 : 10;
      await db.query('UPDATE users SET points = points + ? WHERE id = ?', [pts, req.user.id]);
      await db.query(
        'INSERT INTO points_history (user_id, points_change, reason) VALUES (?,?,?)',
        [req.user.id, pts, `Skill test - ${skillName}`]
      );
    }

    res.json({
      totalScore,
      passed,
      mcqScore,
      mcqTotal: 10,
      mcqResults,
      theoryResults: theoryEval.results,
      message: passed
        ? `🎉 Congratulations! You scored ${totalScore}/100 and are now a verified teacher for ${skillName}!`
        : `You scored ${totalScore}/100. You need 70+ to pass. Retake available after 48 hours.`,
      retakeAfter
    });

  } catch (err) {
    console.error('Evaluate error:', err);
    res.status(500).json({ error: 'Failed to evaluate test. Please try again.' });
  }
});

module.exports = router;
