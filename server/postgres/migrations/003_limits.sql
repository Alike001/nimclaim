CREATE TABLE staging_rate (
  key text PRIMARY KEY CHECK(key IN ('login','api')), count integer NOT NULL, until safe_integer NOT NULL);
