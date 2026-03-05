const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  user: process.env.DB_USER,
  host: "localhost",
  database: "study_planner",
  password: process.env.DB_PASSWORD,
  port: 5432,
});

async function ensureSchemaUpdates() {
  try {
    await pool.query("ALTER TABLE coursework_items ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_coursework_completed_at ON coursework_items(completed_at)");
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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "StudyPlanHome.html"));
});

app.get("/sessions", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "Sessions.html"));
});

app.get("/history", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "History.html"));
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

ensureSchemaUpdates().finally(() => {
  app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
  });
});
