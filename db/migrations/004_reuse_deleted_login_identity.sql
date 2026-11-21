-- Deactivated accounts retain their login identity for audit, but must not
-- block that identity from being registered on a new active account.
DROP INDEX IF EXISTS users_login_identity_unique;
CREATE UNIQUE INDEX users_login_identity_unique
  ON users(login_identity)
  WHERE active = true AND login_identity IS NOT NULL;
