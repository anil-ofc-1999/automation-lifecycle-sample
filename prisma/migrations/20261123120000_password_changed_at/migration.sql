-- Change password (D-32): tokens issued before this moment are no longer accepted.
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMPTZ(3);
