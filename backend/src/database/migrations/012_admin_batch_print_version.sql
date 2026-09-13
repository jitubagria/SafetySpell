ALTER TABLE tag_batches ADD COLUMN print_version integer NOT NULL DEFAULT 1 CHECK (print_version > 0);
