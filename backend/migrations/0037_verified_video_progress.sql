-- Video lessons complete only after the server has seen enough real playback (handlers/student.ts).
-- Length of the lesson video in seconds. Vimeo: read by the server from oEmbed; other providers:
-- the first length a player reports. Reset to NULL when the lesson's video changes.
ALTER TABLE lessons ADD COLUMN duration_seconds REAL;
-- Playback time the server has credited from player heartbeats, and the last heartbeat it credited from.
ALTER TABLE lesson_progress ADD COLUMN watched_seconds REAL NOT NULL DEFAULT 0;
ALTER TABLE lesson_progress ADD COLUMN last_position REAL;
ALTER TABLE lesson_progress ADD COLUMN last_beat_ms INTEGER;
