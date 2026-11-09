-- Pay by @username. Off until the user opts in, so a username never reveals a
-- wallet address without consent.
ALTER TABLE personal_users ADD COLUMN payable_by_username boolean NOT NULL DEFAULT false;
