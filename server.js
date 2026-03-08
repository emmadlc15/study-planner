const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT) || 3000;
const useSsl = process.env.DB_SSL === "true" || Boolean(process.env.DATABASE_URL);

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
      }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST || "localhost",
        database: process.env.DB_NAME || "study_planner",
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT) || 5432,
      }
);

const MAX_URGENCY_DAYS = 60;
const MAX_FORGETTING_DAYS = 30;

function isValidDateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function parsePriorityPayload(payload, { partial = false } = {}) {
  const parsed = {};
  const hasCourseworkItemId = Object.prototype.hasOwnProperty.call(payload, "courseworkItemId");
  const hasExamDate = Object.prototype.hasOwnProperty.call(payload, "examDate");
  const hasLastReviewedAt = Object.prototype.hasOwnProperty.call(payload, "lastReviewedAt");
  const hasConfidence = Object.prototype.hasOwnProperty.call(payload, "confidence");
  const hasImportance = Object.prototype.hasOwnProperty.call(payload, "importance");
  const hasEstimated = Object.prototype.hasOwnProperty.call(payload, "estimatedTimeNeededMinutes");

  if (!partial || hasCourseworkItemId) {
    const courseworkItemId = Number(payload.courseworkItemId);
    if (!Number.isInteger(courseworkItemId) || courseworkItemId <= 0) {
      return { error: "Invalid coursework item id" };
    }
    parsed.courseworkItemId = courseworkItemId;
  }

  if (!partial || hasExamDate) {
    const examDate = typeof payload.examDate === "string" ? payload.examDate.trim() : "";
    if (!isValidDateOnly(examDate)) {
      return { error: "Invalid exam date" };
    }
    parsed.examDate = examDate;
  }

  if (!partial || hasLastReviewedAt) {
    const lastReviewedAt = typeof payload.lastReviewedAt === "string" ? payload.lastReviewedAt.trim() : "";
    if (!isValidDateOnly(lastReviewedAt)) {
      return { error: "Invalid last reviewed date" };
    }
    parsed.lastReviewedAt = lastReviewedAt;
  }

  if (!partial || hasConfidence) {
    const confidence = Number(payload.confidence);
    if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
      return { error: "Invalid confidence value" };
    }
    parsed.confidence = confidence;
  }

  if (!partial || hasImportance) {
    const importance = Number(payload.importance);
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      return { error: "Invalid importance value" };
    }
    parsed.importance = importance;
  }

  if (!partial || hasEstimated) {
    const estimatedTimeNeededMinutes = Number(payload.estimatedTimeNeededMinutes);
    if (!Number.isInteger(estimatedTimeNeededMinutes) || estimatedTimeNeededMinutes <= 0) {
      return { error: "Invalid estimated time needed value" };
    }
    parsed.estimatedTimeNeededMinutes = estimatedTimeNeededMinutes;
  }

  if (partial && !Object.keys(parsed).length) {
    return { error: "No valid fields to update" };
  }

  return { parsed };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function daysBetween(dateA, dateB) {
  const utcA = Date.UTC(dateA.getFullYear(), dateA.getMonth(), dateA.getDate());
  const utcB = Date.UTC(dateB.getFullYear(), dateB.getMonth(), dateB.getDate());
  return Math.floor((utcA - utcB) / (1000 * 60 * 60 * 24));
}

function getComponentScores(row, today) {
  if (
    row.confidence == null ||
    row.importance == null ||
    !row.exam_date ||
    !row.last_reviewed_at ||
    row.estimated_time_needed_minutes == null
  ) {
    return null;
  }

  const examDate = new Date(row.exam_date);
  const lastReviewedAt = new Date(row.last_reviewed_at);
  if (Number.isNaN(examDate.getTime()) || Number.isNaN(lastReviewedAt.getTime())) {
    return null;
  }

  const daysUntilExam = daysBetween(examDate, today);
  const daysSinceReview = daysBetween(today, lastReviewedAt);

  const urgency = clamp(((MAX_URGENCY_DAYS - daysUntilExam) / MAX_URGENCY_DAYS) * 100, 0, 100);
  const knowledgeGap = clamp(((5 - Number(row.confidence)) / 4) * 100, 0, 100);
  const importance = clamp(((Number(row.importance) - 1) / 4) * 100, 0, 100);
  const forgettingRisk = clamp((daysSinceReview / MAX_FORGETTING_DAYS) * 100, 0, 100);

  const sps = (urgency * 0.35) + (knowledgeGap * 0.30) + (importance * 0.20) + (forgettingRisk * 0.15);

  return {
    urgency: Number(urgency.toFixed(2)),
    knowledgeGap: Number(knowledgeGap.toFixed(2)),
    importance: Number(importance.toFixed(2)),
    forgettingRisk: Number(forgettingRisk.toFixed(2)),
    sps: Number(sps.toFixed(2)),
  };
}

function distributeMinutes(scoredItems, dailyMinutes) {
  if (!scoredItems.length || dailyMinutes <= 0) {
    return new Map();
  }

  const totalSps = scoredItems.reduce((sum, item) => sum + item.components.sps, 0);
  const withRaw = scoredItems.map((item) => {
    const baseWeight = totalSps > 0 ? item.components.sps / totalSps : 1 / scoredItems.length;
    const raw = dailyMinutes * baseWeight;
    const floored = Math.floor(raw);
    return {
      courseworkItemId: item.courseworkItemId,
      floored,
      fraction: raw - floored,
    };
  });

  let assigned = withRaw.reduce((sum, item) => sum + item.floored, 0);
  let remainder = dailyMinutes - assigned;
  withRaw.sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < withRaw.length && remainder > 0; i += 1) {
    withRaw[i].floored += 1;
    remainder -= 1;
  }

  const allocation = new Map();
  withRaw.forEach((item) => {
    allocation.set(item.courseworkItemId, item.floored);
  });
  return allocation;
}

async function fetchPriorityRows(limit) {
  const result = await pool.query(
    `SELECT
       ci.id AS coursework_item_id,
       ci.title,
       ci.item_type,
       ci.due_date,
       c.id AS course_id,
       c.course_name,
       c.course_color,
       spi.confidence,
       spi.importance,
       spi.exam_date,
       spi.last_reviewed_at,
       spi.estimated_time_needed_minutes,
       spi.updated_at AS priority_updated_at
     FROM coursework_items ci
     JOIN courses c ON c.id = ci.course_id
     LEFT JOIN study_priority_inputs spi ON spi.coursework_item_id = ci.id
     WHERE ci.completed_at IS NULL
     ORDER BY ci.due_date ASC, ci.created_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

async function ensureSchemaUpdates() {
  try {
    await pool.query("ALTER TABLE coursework_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_coursework_completed_at ON coursework_items(completed_at)");
    await pool.query(
      `CREATE TABLE IF NOT EXISTS study_priority_inputs (
         coursework_item_id INTEGER PRIMARY KEY REFERENCES coursework_items(id) ON DELETE CASCADE,
         confidence SMALLINT NOT NULL CHECK (confidence BETWEEN 1 AND 5),
         importance SMALLINT NOT NULL CHECK (importance BETWEEN 1 AND 5),
         exam_date DATE NOT NULL,
         last_reviewed_at DATE NOT NULL,
         estimated_time_needed_minutes INTEGER NOT NULL CHECK (estimated_time_needed_minutes > 0),
         created_at TIMESTAMP NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMP NOT NULL DEFAULT NOW()
       )`
    );
    await pool.query("CREATE INDEX IF NOT EXISTS idx_priority_exam_date ON study_priority_inputs(exam_date)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_priority_last_reviewed_at ON study_priority_inputs(last_reviewed_at)");
  } catch (err) {
    console.error("Schema update check failed:", err);
  }
}

app.get("/test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Database error");
  }
});

app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/readyz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.status(200).json({ status: "ready" });
  } catch (err) {
    console.error(err);
    return res.status(503).json({ status: "not_ready" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "StudyPlanHome.html"));
});

app.get("/sessions", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Sessions.html"));
});

app.get("/history", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "History.html"));
});

app.get("/priorities", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Priorities.html"));
});

app.get("/api/courses", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, course_name, current_grade, course_color
       FROM courses
       ORDER BY course_name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch courses" });
  }
});

app.post("/api/courses", async (req, res) => {
  const { courseName, currentGrade, courseColor } = req.body;
  const grade = Number(currentGrade);
  const color = typeof courseColor === "string" ? courseColor.trim() : "";
  const name = typeof courseName === "string" ? courseName.trim() : "";

  if (!name || !Number.isFinite(grade) || grade < 0 || grade > 100 || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return res.status(400).json({ error: "Invalid course payload" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO courses (course_name, current_grade, course_color)
       VALUES ($1, $2, $3)
       RETURNING id, course_name, current_grade, course_color`,
      [name, grade, color]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "Course name already exists" });
    }
    return res.status(500).json({ error: "Failed to create course" });
  }
});

app.delete("/api/courses/:id", async (req, res) => {
  const courseId = Number(req.params.id);
  if (!Number.isInteger(courseId) || courseId <= 0) {
    return res.status(400).json({ error: "Invalid course id" });
  }

  try {
    const result = await pool.query("DELETE FROM courses WHERE id = $1 RETURNING id", [courseId]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Course not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete course" });
  }
});

app.get("/api/coursework", async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 5000)
    : 500;

  try {
    const result = await pool.query(
      `SELECT
         ci.id,
         ci.course_id,
         c.course_name,
         c.course_color,
         ci.item_type,
         ci.title,
         ci.due_date,
         ci.completed_at,
         ci.created_at
       FROM coursework_items ci
       JOIN courses c ON c.id = ci.course_id
       ORDER BY ci.due_date ASC, ci.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch coursework items" });
  }
});

app.post("/api/coursework", async (req, res) => {
  const { courseId, itemType, title, dueDate } = req.body;
  const validCourseId = Number(courseId);
  const validType = typeof itemType === "string" ? itemType.trim().toLowerCase() : "";
  const validTitle = typeof title === "string" ? title.trim() : "";
  const validDueDate = typeof dueDate === "string" ? dueDate.trim() : "";

  if (
    !Number.isInteger(validCourseId) ||
    validCourseId <= 0 ||
    !["assignment", "quiz", "test"].includes(validType) ||
    !validTitle ||
    !/^\d{4}-\d{2}-\d{2}$/.test(validDueDate)
  ) {
    return res.status(400).json({ error: "Invalid coursework payload" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO coursework_items (course_id, item_type, title, due_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id, course_id, item_type, title, due_date, completed_at, created_at`,
      [validCourseId, validType, validTitle, validDueDate]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create coursework item" });
  }
});

app.patch("/api/coursework/:id/complete", async (req, res) => {
  const itemId = Number(req.params.id);
  const completed = req.body && typeof req.body.completed === "boolean" ? req.body.completed : true;

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid coursework id" });
  }

  try {
    const result = await pool.query(
      `UPDATE coursework_items
       SET completed_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END
       WHERE id = $1
       RETURNING id, completed_at`,
      [itemId, completed]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Coursework item not found" });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update coursework completion" });
  }
});

app.delete("/api/coursework/:id", async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid coursework id" });
  }

  try {
    const result = await pool.query("DELETE FROM coursework_items WHERE id = $1 RETURNING id", [itemId]);
    if (!result.rowCount) {
      return res.status(404).json({ error: "Coursework item not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to delete coursework item" });
  }
});

app.post("/api/sessions", async (req, res) => {
  const { courseId, startedAt, endedAt, elapsedSeconds, resetCount } = req.body;

  const validCourseId = Number(courseId);
  const validElapsedSeconds = Number(elapsedSeconds);
  const validResetCount = Number(resetCount);

  if (
    !Number.isInteger(validCourseId) ||
    validCourseId <= 0 ||
    !startedAt ||
    !endedAt ||
    !Number.isInteger(validElapsedSeconds) ||
    validElapsedSeconds < 0 ||
    !Number.isInteger(validResetCount) ||
    validResetCount < 0
  ) {
    return res.status(400).json({ error: "Invalid session payload" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO study_sessions (course_id, started_at, ended_at, elapsed_seconds, reset_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [validCourseId, startedAt, endedAt, validElapsedSeconds, validResetCount]
    );

    return res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to log session" });
  }
});

app.get("/api/sessions", async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 5000)
    : 50;

  try {
    const result = await pool.query(
      `SELECT
         s.id,
         s.course_id,
         c.course_name,
         c.course_color,
         s.started_at,
         s.ended_at,
         s.elapsed_seconds,
         s.reset_count,
         s.created_at
       FROM study_sessions s
       JOIN courses c ON c.id = s.course_id
       ORDER BY s.started_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

app.get("/api/priorities", async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 5000)
    : 500;
  const requestedDailyMinutes = Number(req.query.dailyMinutes);
  const dailyMinutes = Number.isInteger(requestedDailyMinutes) && requestedDailyMinutes >= 0
    ? Math.min(requestedDailyMinutes, 1440)
    : 120;

  try {
    const rows = await fetchPriorityRows(limit);
    const today = new Date();

    const shaped = rows.map((row) => {
      const components = getComponentScores(row, today);
      return {
        courseworkItemId: Number(row.coursework_item_id),
        title: row.title,
        itemType: row.item_type,
        dueDate: row.due_date,
        courseId: Number(row.course_id),
        courseName: row.course_name,
        courseColor: row.course_color,
        confidence: row.confidence == null ? null : Number(row.confidence),
        importance: row.importance == null ? null : Number(row.importance),
        examDate: row.exam_date,
        lastReviewedAt: row.last_reviewed_at,
        estimatedTimeNeededMinutes: row.estimated_time_needed_minutes == null ? null : Number(row.estimated_time_needed_minutes),
        priorityUpdatedAt: row.priority_updated_at,
        components,
      };
    });

    const scored = shaped.filter((item) => item.components);
    const allocations = distributeMinutes(scored, dailyMinutes);
    const results = shaped
      .map((item) => ({
        ...item,
        recommendedMinutes: item.components ? (allocations.get(item.courseworkItemId) || 0) : 0,
      }))
      .sort((a, b) => {
        const scoreA = a.components ? a.components.sps : -1;
        const scoreB = b.components ? b.components.sps : -1;
        return scoreB - scoreA;
      });

    return res.json({
      dailyMinutes,
      totalRecommendedMinutes: results.reduce((sum, item) => sum + item.recommendedMinutes, 0),
      items: results,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch priorities" });
  }
});

app.post("/api/priorities", async (req, res) => {
  const { parsed, error } = parsePriorityPayload(req.body || {});
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const exists = await pool.query(
      "SELECT id FROM coursework_items WHERE id = $1",
      [parsed.courseworkItemId]
    );
    if (!exists.rowCount) {
      return res.status(404).json({ error: "Coursework item not found" });
    }

    const result = await pool.query(
      `INSERT INTO study_priority_inputs
         (coursework_item_id, confidence, importance, exam_date, last_reviewed_at, estimated_time_needed_minutes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (coursework_item_id) DO UPDATE SET
         confidence = EXCLUDED.confidence,
         importance = EXCLUDED.importance,
         exam_date = EXCLUDED.exam_date,
         last_reviewed_at = EXCLUDED.last_reviewed_at,
         estimated_time_needed_minutes = EXCLUDED.estimated_time_needed_minutes,
         updated_at = NOW()
       RETURNING coursework_item_id, confidence, importance, exam_date, last_reviewed_at, estimated_time_needed_minutes, updated_at`,
      [
        parsed.courseworkItemId,
        parsed.confidence,
        parsed.importance,
        parsed.examDate,
        parsed.lastReviewedAt,
        parsed.estimatedTimeNeededMinutes,
      ]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to save priority inputs" });
  }
});

app.patch("/api/priorities/:itemId", async (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid coursework item id" });
  }

  const { parsed, error } = parsePriorityPayload(req.body || {}, { partial: true });
  if (error) {
    return res.status(400).json({ error });
  }

  const updates = [];
  const values = [];
  let index = 1;

  if (Object.prototype.hasOwnProperty.call(parsed, "confidence")) {
    updates.push(`confidence = $${index}`);
    values.push(parsed.confidence);
    index += 1;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "importance")) {
    updates.push(`importance = $${index}`);
    values.push(parsed.importance);
    index += 1;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "examDate")) {
    updates.push(`exam_date = $${index}`);
    values.push(parsed.examDate);
    index += 1;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "lastReviewedAt")) {
    updates.push(`last_reviewed_at = $${index}`);
    values.push(parsed.lastReviewedAt);
    index += 1;
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "estimatedTimeNeededMinutes")) {
    updates.push(`estimated_time_needed_minutes = $${index}`);
    values.push(parsed.estimatedTimeNeededMinutes);
    index += 1;
  }

  updates.push("updated_at = NOW()");
  values.push(itemId);

  try {
    const result = await pool.query(
      `UPDATE study_priority_inputs
       SET ${updates.join(", ")}
       WHERE coursework_item_id = $${index}
       RETURNING coursework_item_id, confidence, importance, exam_date, last_reviewed_at, estimated_time_needed_minutes, updated_at`,
      values
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Priority inputs not found for this coursework item" });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to update priority inputs" });
  }
});

ensureSchemaUpdates().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
