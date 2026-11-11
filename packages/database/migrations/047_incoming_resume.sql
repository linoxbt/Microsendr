-- A long explorer walk continues where it stopped instead of skipping older pages,
-- and a candidate the node could not yet prove holds the cursor below it.
ALTER TABLE chain_incoming_cursors
  ADD COLUMN resume_params jsonb,
  ADD COLUMN resume_through_block bigint,
  ADD COLUMN pending_block bigint;
