-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE users ADD COLUMN profile_revision INTEGER NOT NULL DEFAULT 0;
