-- Why an approved Didit check is held for manual review (for example, the document
-- does not match the name or date of birth on the Roots profile).
ALTER TABLE personal_didit_sessions ADD COLUMN review_reason text;
