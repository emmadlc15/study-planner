-- Study Planner schema (PostgreSQL)
-- Supports:
-- 1) Courses with current grade
-- 2) Assignments, quizzes, and tests linked to each course with dates

DROP TABLE IF EXISTS study_sessions;
DROP TABLE IF EXISTS study_priority_inputs;
DROP TABLE IF EXISTS coursework_items;
DROP TABLE IF EXISTS courses;

CREATE TABLE courses (
  id SERIAL PRIMARY KEY,
  course_name VARCHAR(120) NOT NULL UNIQUE,
  current_grade NUMERIC(5, 2) NOT NULL CHECK (current_grade >= 0 AND current_grade <= 100),
  course_color CHAR(7) NOT NULL CHECK (course_color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE coursework_items (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('assignment', 'quiz', 'test')),
  title VARCHAR(160) NOT NULL,
  due_date DATE NOT NULL,
  completed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE study_sessions (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP NOT NULL,
  elapsed_seconds INTEGER NOT NULL CHECK (elapsed_seconds >= 0),
  reset_count INTEGER NOT NULL DEFAULT 0 CHECK (reset_count >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE study_priority_inputs (
  coursework_item_id INTEGER PRIMARY KEY REFERENCES coursework_items(id) ON DELETE CASCADE,
  confidence SMALLINT NOT NULL CHECK (confidence BETWEEN 1 AND 5),
  importance SMALLINT NOT NULL CHECK (importance BETWEEN 1 AND 5),
  exam_date DATE NOT NULL,
  last_reviewed_at DATE NOT NULL,
  estimated_time_needed_minutes INTEGER NOT NULL CHECK (estimated_time_needed_minutes > 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coursework_course_id ON coursework_items(course_id);
CREATE INDEX idx_coursework_due_date ON coursework_items(due_date);
CREATE INDEX idx_coursework_completed_at ON coursework_items(completed_at);
CREATE INDEX idx_study_sessions_course_id ON study_sessions(course_id);
CREATE INDEX idx_study_sessions_started_at ON study_sessions(started_at);
CREATE INDEX idx_priority_exam_date ON study_priority_inputs(exam_date);
CREATE INDEX idx_priority_last_reviewed_at ON study_priority_inputs(last_reviewed_at);
