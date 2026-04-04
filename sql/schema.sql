CREATE DATABASE IF NOT EXISTS eval_pipeline;
USE eval_pipeline;

CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(64) PRIMARY KEY,
  agent_version VARCHAR(32),
  turns JSON,
  feedback JSON,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_agent_version (agent_version),
  INDEX idx_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id VARCHAR(64) PRIMARY KEY,
  conversation_id VARCHAR(64),
  scores JSON,
  tool_evaluation JSON,
  issues_detected JSON,
  improvement_suggestions JSON,
  evaluator_version VARCHAR(32) DEFAULT 'v1',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_eval_conv_id (conversation_id),
  INDEX idx_eval_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS annotations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id VARCHAR(64),
  annotator_id VARCHAR(64),
  annotation_type VARCHAR(64),
  label VARCHAR(64),
  confidence FLOAT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_anno_conv_id (conversation_id),
  INDEX idx_anno_annotator_type (annotator_id, annotation_type)
);

CREATE TABLE IF NOT EXISTS meta_evaluations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  evaluator_type VARCHAR(64),
  conversation_id VARCHAR(64),
  eval_score FLOAT,
  human_label VARCHAR(64),
  agreement BOOLEAN,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('prompt','tool'),
  target VARCHAR(255),
  pattern TEXT,
  suggestion TEXT,
  rationale TEXT,
  confidence FLOAT,
  supporting_conversation_ids JSON,
  status ENUM('pending','accepted','rejected','applied') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drift_corrections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  evaluator_type VARCHAR(64),
  correction_factor FLOAT,
  drift_at_time FLOAT,
  sample_size INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_drift_evaluator (evaluator_type)
);

-- Async job queue (MySQL-as-queue pattern, no external broker needed)
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  type ENUM('evaluation','batch_evaluation','suggestion_cycle') NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
  result JSON,
  error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  INDEX idx_jobs_status (status),
  INDEX idx_jobs_created (created_at)
);
