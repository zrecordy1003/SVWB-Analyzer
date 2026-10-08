-- The Google profile picture URL, carried from the callback to the one token
-- exchange that follows it, and nowhere else.
--
-- It lives on the GRANT, which is deleted when spent (a few minutes at most),
-- and not on `accounts`: the app only needs it at sign-in time and keeps its own
-- copy, so storing it here would be holding personal data for nothing - and one
-- more write on every login.
ALTER TABLE grants ADD COLUMN picture TEXT;
